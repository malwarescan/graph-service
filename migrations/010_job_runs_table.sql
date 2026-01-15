-- Migration 010: Job Runs Tracking Table
-- Creates table for tracking scheduled ingestion job runs

CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_name TEXT NOT NULL,
  job_run_id TEXT UNIQUE NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration INTEGER, -- milliseconds
  status TEXT NOT NULL DEFAULT 'running', -- running, success, failed
  records_processed INTEGER DEFAULT 0,
  records_inserted INTEGER DEFAULT 0,
  records_quarantined INTEGER DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_name ON job_runs (job_name);
CREATE INDEX IF NOT EXISTS idx_job_runs_start_time ON job_runs (start_time DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs (status);

COMMENT ON TABLE job_runs IS 'Tracks execution of scheduled ingestion jobs';
