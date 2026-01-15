-- Migration 009: Environmental Local Climate Domain Support
-- Creates support for environmental.local_climate domain in Croutons Graph

-- Add domain-specific metadata table for environmental data
CREATE TABLE IF NOT EXISTS environmental_climate_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  crouton_id TEXT NOT NULL REFERENCES croutons(crouton_id) ON DELETE CASCADE,
  
  -- Temperature data
  temp_max NUMERIC,
  temp_min NUMERIC,
  dew_point NUMERIC,
  
  -- Precipitation and humidity
  precipitation NUMERIC,
  humidity_index NUMERIC,
  wind_speed NUMERIC,
  
  -- Storm data
  storm_event TEXT,
  storm_intensity TEXT,
  uv_proxy TEXT,
  
  -- Seasonal context
  seasonality_vector JSONB,
  
  -- Location data
  observation_date DATE NOT NULL,
  zip TEXT,
  lat NUMERIC,
  lon NUMERIC,
  county TEXT,
  
  -- Source metadata
  source TEXT NOT NULL,
  station_id TEXT,
  data_quality TEXT DEFAULT 'unverified',
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure one record per crouton
  CONSTRAINT uq_environmental_crouton UNIQUE (crouton_id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_env_climate_date ON environmental_climate_data (observation_date DESC);
CREATE INDEX IF NOT EXISTS idx_env_climate_zip ON environmental_climate_data (zip) WHERE zip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_env_climate_location ON environmental_climate_data (lat, lon) WHERE lat IS NOT NULL AND lon IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_env_climate_source ON environmental_climate_data (source);
CREATE INDEX IF NOT EXISTS idx_env_climate_county ON environmental_climate_data (county) WHERE county IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_env_climate_storm ON environmental_climate_data (storm_event) WHERE storm_event IS NOT NULL AND storm_event != 'none';

-- Composite index for location + date queries (common for CASA)
CREATE INDEX IF NOT EXISTS idx_env_climate_zip_date ON environmental_climate_data (zip, observation_date DESC) WHERE zip IS NOT NULL;

-- Add domain registry entry
CREATE TABLE IF NOT EXISTS domain_registry (
  domain_name TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  schema_url TEXT,
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Register the environmental.local_climate domain
INSERT INTO domain_registry (domain_name, schema_version, schema_url, description)
VALUES (
  'environmental.local_climate',
  'v1',
  'https://croutons.ai/schemas/environmental.local_climate/v1',
  'Local environmental and climate data from NOAA and other sources for home intelligence applications'
)
ON CONFLICT (domain_name) DO UPDATE SET
  schema_version = EXCLUDED.schema_version,
  schema_url = EXCLUDED.schema_url,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Create a view for easy querying of environmental data
CREATE OR REPLACE VIEW v_environmental_climate AS
SELECT 
  c.crouton_id,
  c.source_url,
  c.corpus_id,
  c.text AS description,
  e.temp_max,
  e.temp_min,
  e.dew_point,
  e.precipitation,
  e.humidity_index,
  e.wind_speed,
  e.storm_event,
  e.storm_intensity,
  e.uv_proxy,
  e.seasonality_vector,
  e.observation_date,
  e.zip,
  e.lat,
  e.lon,
  e.county,
  e.source,
  e.station_id,
  e.data_quality,
  e.created_at,
  e.updated_at
FROM croutons c
INNER JOIN environmental_climate_data e ON c.crouton_id = e.crouton_id
WHERE c.corpus_id = 'environmental.local_climate';

-- Add comment for documentation
COMMENT ON TABLE environmental_climate_data IS 'Structured environmental and climate data linked to croutons for the environmental.local_climate domain';
COMMENT ON VIEW v_environmental_climate IS 'Unified view of environmental climate data with crouton metadata';
