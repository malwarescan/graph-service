#!/usr/bin/env node

/**
 * Verification Script: Precogs Environmental Climate Domain Access
 * 
 * This script verifies that Precogs can successfully access the
 * environmental.local_climate domain from the Croutons Graph.
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false
});

async function verifyDomainAccess() {
    console.log('🔍 Verifying environmental.local_climate domain access...\n');

    try {
        // 1. Check domain registry
        console.log('1️⃣ Checking domain registry...');
        const domainCheck = await pool.query(
            `SELECT * FROM domain_registry WHERE domain_name = $1`,
            ['environmental.local_climate']
        );

        if (domainCheck.rows.length === 0) {
            console.error('❌ Domain not found in registry');
            return false;
        }

        const domain = domainCheck.rows[0];
        console.log(`✅ Domain registered: ${domain.domain_name}`);
        console.log(`   Schema version: ${domain.schema_version}`);
        console.log(`   Description: ${domain.description}`);
        console.log(`   Active: ${domain.active}`);
        console.log('');

        // 2. Check environmental_climate_data table exists
        console.log('2️⃣ Checking environmental_climate_data table...');
        const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'environmental_climate_data'
      ) as exists
    `);

        if (!tableCheck.rows[0].exists) {
            console.error('❌ environmental_climate_data table not found');
            return false;
        }
        console.log('✅ environmental_climate_data table exists');
        console.log('');

        // 3. Check view exists
        console.log('3️⃣ Checking v_environmental_climate view...');
        const viewCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.views 
        WHERE table_name = 'v_environmental_climate'
      ) as exists
    `);

        if (!viewCheck.rows[0].exists) {
            console.error('❌ v_environmental_climate view not found');
            return false;
        }
        console.log('✅ v_environmental_climate view exists');
        console.log('');

        // 4. Check indexes
        console.log('4️⃣ Checking indexes...');
        const indexCheck = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'environmental_climate_data'
      ORDER BY indexname
    `);

        console.log(`✅ Found ${indexCheck.rows.length} indexes:`);
        indexCheck.rows.forEach(row => {
            console.log(`   - ${row.indexname}`);
        });
        console.log('');

        // 5. Test query capability
        console.log('5️⃣ Testing query capability...');
        const queryTest = await pool.query(`
      SELECT COUNT(*) as count 
      FROM environmental_climate_data
    `);
        console.log(`✅ Query successful (${queryTest.rows[0].count} records currently)`);
        console.log('');

        // 6. Test view query
        console.log('6️⃣ Testing view query...');
        const viewTest = await pool.query(`
      SELECT COUNT(*) as count 
      FROM v_environmental_climate
    `);
        console.log(`✅ View query successful (${viewTest.rows[0].count} records)`);
        console.log('');

        console.log('═══════════════════════════════════════════════════');
        console.log('✅ ALL CHECKS PASSED');
        console.log('═══════════════════════════════════════════════════');
        console.log('');
        console.log('Precogs can now access environmental.local_climate domain!');
        console.log('');
        console.log('Next steps:');
        console.log('  1. Begin Phase 2: NOAA data normalization');
        console.log('  2. Ingest climate data using the schema');
        console.log('  3. Test Precogs reasoning with real climate data');
        console.log('');

        return true;
    } catch (error) {
        console.error('❌ Verification failed:', error.message);
        console.error(error);
        return false;
    } finally {
        await pool.end();
    }
}

// Run verification
verifyDomainAccess()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
