-- 004_unique_source_hash.sql
-- Ensure ON CONFLICT (source_hash) works by adding a UNIQUE index.
-- Multiple NULLs are allowed by default in a UNIQUE index.

CREATE UNIQUE INDEX IF NOT EXISTS croutons_source_hash_unique_idx
ON croutons (source_hash);