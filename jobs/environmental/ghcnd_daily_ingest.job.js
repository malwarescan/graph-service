/**
 * GHCND Daily Ingestion Job
 * 
 * Fetches daily climate data from GHCND and ingests into environmental.local_climate domain.
 * Runs daily at 2 AM UTC.
 * 
 * @module ghcnd_daily_ingest
 */

const GhcndAdapter = require('../../../casa-ingestion/noaa/ghcndAdapter');
const GhcndToCwnf = require('../../../casa-ingestion/normalizers/ghcndToCwnf');
const CroutonEmitter = require('../../../casa-ingestion/emitter/croutonEmitter');
const { Pool } = require('pg');

// Configuration
const NOAA_API_TOKEN = process.env.NOAA_API_TOKEN;
const TARGET_ZIPS = (process.env.CASA_TARGET_ZIPS || '33907,34103,33901').split(',');
const LOOKBACK_DAYS = parseInt(process.env.GHCND_LOOKBACK_DAYS || '7', 10);

// Location metadata for target ZIPs
const LOCATION_DATA = {
    '33907': { zip: '33907', lat: 26.6406, lon: -81.8723, county: 'Lee' },
    '34103': { zip: '34103', lat: 26.1420, lon: -81.7948, county: 'Collier' },
    '33901': { zip: '33901', lat: 26.6431, lon: -81.8723, county: 'Lee' }
};

class GhcndDailyIngestJob {
    constructor() {
        this.jobName = 'ghcnd_daily_ingest';
        this.adapter = null;
        this.emitter = null;
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL.includes('railway')
                ? { rejectUnauthorized: false }
                : false
        });
    }

    /**
     * Run the ingestion job
     * 
     * @returns {Promise<Object>} Job results
     */
    async run() {
        const startTime = Date.now();
        const jobRunId = this._generateJobRunId();

        console.log(`[${this.jobName}] Starting job run ${jobRunId}`);

        try {
            // Validate configuration
            if (!NOAA_API_TOKEN) {
                throw new Error('NOAA_API_TOKEN environment variable is required');
            }

            // Initialize components
            this.adapter = new GhcndAdapter(NOAA_API_TOKEN);
            this.emitter = new CroutonEmitter(this._createGraphClient());

            // Calculate date range
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
                .toISOString()
                .split('T')[0];

            console.log(`[${this.jobName}] Fetching data from ${startDate} to ${endDate}`);

            // Process each ZIP code
            const results = {
                jobRunId,
                startTime: new Date(startTime).toISOString(),
                zips: [],
                totalFetched: 0,
                totalNormalized: 0,
                totalInserted: 0,
                totalQuarantined: 0,
                errors: []
            };

            for (const zip of TARGET_ZIPS) {
                try {
                    const zipResult = await this._processZip(zip, startDate, endDate);
                    results.zips.push(zipResult);
                    results.totalFetched += zipResult.fetched;
                    results.totalNormalized += zipResult.normalized;
                    results.totalInserted += zipResult.inserted;
                    results.totalQuarantined += zipResult.quarantined;
                } catch (error) {
                    console.error(`[${this.jobName}] Error processing ZIP ${zip}:`, error.message);
                    results.errors.push({
                        zip,
                        error: error.message
                    });
                }
            }

            // Calculate duration
            const duration = Date.now() - startTime;
            results.endTime = new Date().toISOString();
            results.duration = duration;

            // Log summary
            this._logSummary(results);

            // Record in job_runs table
            await this._recordJobRun(results);

            // Check for schema mismatches
            if (results.totalQuarantined > 0) {
                const quarantineRate = (results.totalQuarantined / results.totalNormalized) * 100;
                if (quarantineRate > 5) {
                    throw new Error(`High quarantine rate: ${quarantineRate.toFixed(2)}% - possible schema mismatch`);
                }
            }

            // Push quarantine summary to Slack if needed
            if (results.totalQuarantined > 0) {
                await this._pushQuarantineSummary(results);
            }

            console.log(`[${this.jobName}] Job completed successfully`);

            return results;
        } catch (error) {
            console.error(`[${this.jobName}] Job failed:`, error);

            // Record failure
            await this._recordJobRun({
                jobRunId,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date().toISOString(),
                duration: Date.now() - startTime,
                status: 'failed',
                error: error.message
            });

            throw error;
        } finally {
            await this.pool.end();
        }
    }

    /**
     * Process a single ZIP code
     * 
     * @private
     * @param {string} zip - ZIP code
     * @param {string} startDate - Start date
     * @param {string} endDate - End date
     * @returns {Promise<Object>} ZIP processing results
     */
    async _processZip(zip, startDate, endDate) {
        console.log(`[${this.jobName}] Processing ZIP ${zip}`);

        // 1. Fetch from NOAA
        const ghcndData = await this.adapter.fetchByZip(zip, startDate, endDate);
        console.log(`[${this.jobName}] Fetched ${ghcndData.length} records for ${zip}`);

        // 2. Normalize to C-WNF
        const locationData = LOCATION_DATA[zip] || { zip };
        const cwnfRecords = GhcndToCwnf.normalizeBatch(ghcndData, locationData);
        console.log(`[${this.jobName}] Normalized ${cwnfRecords.length} records for ${zip}`);

        // 3. Emit as croutons
        const emitResults = await this.emitter.emitCroutons(cwnfRecords);
        console.log(`[${this.jobName}] Emitted ${emitResults.inserted} croutons for ${zip}`);

        return {
            zip,
            fetched: ghcndData.length,
            normalized: cwnfRecords.length,
            inserted: emitResults.inserted,
            quarantined: emitResults.quarantined,
            duration: emitResults.duration
        };
    }

    /**
     * Create graph client for emitter
     * 
     * @private
     * @returns {Object} Graph client
     */
    _createGraphClient() {
        // Simplified graph client for ingestion
        return {
            ingest: async ({ data }) => {
                // Parse NDJSON
                const lines = data.split('\n').filter(l => l.trim());
                const factlets = lines.map(line => JSON.parse(line));

                // Insert into database
                let inserted = 0;
                for (const factlet of factlets) {
                    const normalized = factlet.normalized;

                    // Insert crouton
                    await this.pool.query(
                        `INSERT INTO croutons (crouton_id, source_url, text, corpus_id, triple)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (crouton_id) DO UPDATE SET
               text = EXCLUDED.text,
               triple = EXCLUDED.triple`,
                        [
                            factlet.fact_id,
                            factlet.page_id,
                            factlet.claim,
                            factlet.corpus_id,
                            null
                        ]
                    );

                    // Insert environmental data
                    await this.pool.query(
                        `INSERT INTO environmental_climate_data (
              crouton_id, temp_max, temp_min, dew_point, precipitation,
              humidity_index, wind_speed, storm_event, storm_intensity,
              uv_proxy, seasonality_vector, observation_date, zip, lat, lon,
              county, source, station_id, data_quality
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (crouton_id) DO UPDATE SET
              temp_max = EXCLUDED.temp_max,
              temp_min = EXCLUDED.temp_min,
              dew_point = EXCLUDED.dew_point,
              precipitation = EXCLUDED.precipitation,
              humidity_index = EXCLUDED.humidity_index,
              wind_speed = EXCLUDED.wind_speed,
              storm_event = EXCLUDED.storm_event,
              storm_intensity = EXCLUDED.storm_intensity,
              uv_proxy = EXCLUDED.uv_proxy,
              seasonality_vector = EXCLUDED.seasonality_vector,
              updated_at = NOW()`,
                        [
                            factlet.fact_id,
                            normalized.temp_max,
                            normalized.temp_min,
                            normalized.dew_point,
                            normalized.precipitation,
                            normalized.humidity_index,
                            normalized.wind_speed,
                            normalized.storm_event,
                            normalized.storm_intensity,
                            normalized.uv_proxy,
                            JSON.stringify(normalized.seasonality_vector),
                            normalized.date,
                            normalized.zip,
                            normalized.lat,
                            normalized.lon,
                            normalized.county,
                            normalized.source,
                            normalized.station_id,
                            normalized.data_quality
                        ]
                    );

                    inserted++;
                }

                return { records_inserted: inserted };
            }
        };
    }

    /**
     * Generate unique job run ID
     * 
     * @private
     * @returns {string} Job run ID
     */
    _generateJobRunId() {
        return `${this.jobName}_${Date.now()}`;
    }

    /**
     * Log job summary
     * 
     * @private
     * @param {Object} results - Job results
     */
    _logSummary(results) {
        console.log('\n' + '='.repeat(60));
        console.log(`GHCND DAILY INGESTION JOB SUMMARY`);
        console.log('='.repeat(60));
        console.log(`Job Run ID: ${results.jobRunId}`);
        console.log(`Duration: ${results.duration}ms`);
        console.log(`ZIPs Processed: ${results.zips.length}`);
        console.log(`Total Fetched: ${results.totalFetched}`);
        console.log(`Total Normalized: ${results.totalNormalized}`);
        console.log(`Total Inserted: ${results.totalInserted}`);
        console.log(`Total Quarantined: ${results.totalQuarantined}`);
        console.log(`Errors: ${results.errors.length}`);
        console.log('='.repeat(60) + '\n');
    }

    /**
     * Record job run in database
     * 
     * @private
     * @param {Object} results - Job results
     */
    async _recordJobRun(results) {
        try {
            await this.pool.query(
                `INSERT INTO job_runs (
          job_name, job_run_id, start_time, end_time, duration,
          status, records_processed, records_inserted, records_quarantined,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    this.jobName,
                    results.jobRunId,
                    results.startTime,
                    results.endTime,
                    results.duration,
                    results.status || 'success',
                    results.totalNormalized || 0,
                    results.totalInserted || 0,
                    results.totalQuarantined || 0,
                    JSON.stringify(results)
                ]
            );
        } catch (error) {
            console.error(`[${this.jobName}] Failed to record job run:`, error.message);
        }
    }

    /**
     * Push quarantine summary to Slack
     * 
     * @private
     * @param {Object} results - Job results
     */
    async _pushQuarantineSummary(results) {
        const quarantineRate = ((results.totalQuarantined / results.totalNormalized) * 100).toFixed(2);

        console.log(`[${this.jobName}] Quarantine Summary:`);
        console.log(`  - Quarantined: ${results.totalQuarantined}`);
        console.log(`  - Rate: ${quarantineRate}%`);

        // TODO: Implement Slack webhook integration
        // const slackWebhook = process.env.SLACK_WEBHOOK_URL;
        // if (slackWebhook) {
        //   await fetch(slackWebhook, {
        //     method: 'POST',
        //     body: JSON.stringify({
        //       text: `GHCND Ingestion: ${results.totalQuarantined} records quarantined (${quarantineRate}%)`
        //     })
        //   });
        // }
    }
}

// Run if executed directly
if (require.main === module) {
    const job = new GhcndDailyIngestJob();
    job.run()
        .then(results => {
            console.log('Job completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Job failed:', error);
            process.exit(1);
        });
}

module.exports = GhcndDailyIngestJob;
