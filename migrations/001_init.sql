-- migrations/001_init.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS croutons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  crouton_id TEXT UNIQUE,
  source_url TEXT NOT NULL,
  source_hash TEXT,
  corpus_id TEXT DEFAULT 'default',
  triple JSONB,
  text TEXT,
  confidence NUMERIC,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_croutons_source_url ON croutons (source_url);
CREATE UNIQUE INDEX IF NOT EXISTS uq_croutons_source_hash ON croutons (source_hash) WHERE source_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS triples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  evidence_crouton_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triples_spo ON triples (subject, predicate, object);
