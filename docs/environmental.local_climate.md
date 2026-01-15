# Environmental Local Climate Domain

**Domain:** `environmental.local_climate`  
**Schema Version:** `v1`  
**Status:** ✅ Active  
**Created:** 2024-11-20

## Overview

The `environmental.local_climate` domain provides structured environmental and climate data for the Croutons Graph, enabling CASA's Local Home Intelligence (LHI) engine and Precogs to reason about environmental stressors, climate patterns, and their impact on homes.

## Purpose

This domain represents:
- Daily environmental conditions
- Microclimate humidity/dew point data
- Storm history and severity
- Seasonal patterns
- Localized environmental stress factors

## Schema Definition

### Core Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `temp_max` | float | No | Maximum temperature (°F) |
| `temp_min` | float | No | Minimum temperature (°F) |
| `dew_point` | float | No | Dew point temperature (°F) |
| `precipitation` | float | No | Precipitation amount (inches) |
| `humidity_index` | float | No | Relative humidity (%) or humidity index |
| `wind_speed` | float | No | Wind speed (mph) |
| `storm_event` | string | No | Type of storm event |
| `storm_intensity` | string | No | Storm intensity classification |
| `uv_proxy` | string | No | UV index classification |
| `seasonality_vector` | object | No | Seasonal pattern metadata |
| `date` | date | **Yes** | Observation date (ISO 8601) |
| `zip` | string | No | ZIP code |
| `lat` | float | No | Latitude (decimal degrees) |
| `lon` | float | No | Longitude (decimal degrees) |
| `county` | string | No | County name or FIPS code |
| `source` | string | **Yes** | Data source (GHCND, LCD, StormEvents, Normals) |

### Storm Event Types

- `none` - No storm activity
- `thunderstorm` - Thunderstorm activity
- `tornado` - Tornado event
- `hurricane` - Hurricane
- `tropical_storm` - Tropical storm
- `hail` - Hail event
- `flood` - Flooding
- `flash_flood` - Flash flooding
- `winter_storm` - Winter storm
- `ice_storm` - Ice storm
- `high_wind` - High wind event
- `other` - Other storm types

### Storm Intensity Levels

- `none` - No storm
- `minor` - Minor impact
- `moderate` - Moderate impact
- `severe` - Severe impact
- `extreme` - Extreme/catastrophic impact

### UV Proxy Classifications

- `low` - UV Index 0-2
- `moderate` - UV Index 3-5
- `high` - UV Index 6-7
- `very_high` - UV Index 8-10
- `extreme` - UV Index 11+
- `unknown` - No data available

### Seasonality Vector

The `seasonality_vector` is a JSON object containing:

```json
{
  "season": "summer",           // winter, spring, summer, fall
  "month": 7,                   // 1-12
  "day_of_year": 195,          // 1-366
  "climate_zone": "Cfa"        // Köppen classification
}
```

## Data Sources

### Supported NOAA Datasets

1. **GHCND** (Global Historical Climatology Network - Daily)
   - Daily temperature, precipitation, snow
   - Station-based observations

2. **LCD** (Local Climatological Data)
   - Hourly/daily summaries
   - Airport weather stations

3. **StormEvents** (Storm Events Database)
   - Severe weather events
   - Storm damage reports

4. **Normals** (Climate Normals)
   - 30-year climate averages
   - Baseline comparisons

## Example Crouton

```json
{
  "@type": "Factlet",
  "fact_id": "env:climate:33301:2024-07-14",
  "page_id": "environmental.local_climate",
  "corpus_id": "environmental.local_climate",
  "claim": "Fort Lauderdale experienced moderate thunderstorm activity with 0.25 inches of rain on July 14, 2024. High temperature reached 85.2°F with 78% humidity.",
  "normalized": {
    "temp_max": 85.2,
    "temp_min": 68.5,
    "dew_point": 72.1,
    "precipitation": 0.25,
    "humidity_index": 78,
    "wind_speed": 12.5,
    "storm_event": "thunderstorm",
    "storm_intensity": "moderate",
    "uv_proxy": "high",
    "seasonality_vector": {
      "season": "summer",
      "month": 7,
      "day_of_year": 195,
      "climate_zone": "Cfa"
    },
    "date": "2024-07-14",
    "zip": "33301",
    "lat": 26.1224,
    "lon": -80.1373,
    "county": "Broward",
    "source": "GHCND",
    "station_id": "GHCND:USW00012839",
    "data_quality": "verified"
  }
}
```

## Database Schema

The domain is supported by:

1. **`environmental_climate_data` table** - Structured climate data
2. **`domain_registry` table** - Domain metadata and versioning
3. **`v_environmental_climate` view** - Convenient query interface

See migration `009_environmental_climate_domain.sql` for full schema.

## API Access

### Query by Location and Date

```bash
GET /api/query?corpus=environmental.local_climate&q=33301
GET /api/query?domain=environmental.local_climate&q=thunderstorm
```

### Precogs Integration

Precogs can access this domain via:

```javascript
const climateData = await queryGraph({
  corpus: 'environmental.local_climate',
  filters: {
    zip: '33301',
    date_range: ['2024-01-01', '2024-12-31']
  }
});
```

## Ingestion Pattern

### NDJSON Format

```ndjson
{"@type":"Factlet","fact_id":"env:climate:33301:2024-07-14","corpus_id":"environmental.local_climate","claim":"...","normalized":{...}}
```

### CLI Ingestion

```bash
croutons-cli ingest \
  --dataset environmental.local_climate \
  --file climate-data.ndjson \
  --site environmental.local_climate
```

## Next Steps (Phase 2)

Once this schema is approved:

1. ✅ NOAA API key acquisition
2. ✅ CDO (Climate Data Online) request templates
3. ✅ GHCND normalization scripts
4. ✅ LCD normalization scripts
5. ✅ StormEvents normalization scripts
6. ✅ Normals normalization scripts
7. ✅ "Casa Weather Normal Form" (C-WNF) transformer
8. ✅ Automated crouton emission pipeline

## Validation

Schema validation is available at:
- JSON Schema: `/graph-service/schemas/environmental.local_climate.v1.json`
- Database migration: `/graph-service/migrations/009_environmental_climate_domain.sql`

## Contact

For questions about this domain:
- **Croutons Team**: Schema and ingestion pipeline
- **Precogs Team**: Reasoning and inference logic
- **CASA Team**: Integration and use cases
