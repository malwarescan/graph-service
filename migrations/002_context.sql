-- migrations/002_context.sql
ALTER TABLE croutons
  ADD COLUMN IF NOT EXISTS context_hash TEXT,
  ADD COLUMN IF NOT EXISTS contextually_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verification_meta JSONB;
