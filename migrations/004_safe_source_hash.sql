-- 004_safe_source_hash.sql
-- Make sure source_hash is uniquely constrained only when present.
-- This prevents NULL conflicts and supports dedupe.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1
             FROM pg_indexes
             WHERE schemaname='public' AND indexname='croutons_source_hash_uidx') THEN
    EXECUTE 'DROP INDEX IF EXISTS croutons_source_hash_uidx';
  END IF;
END$$;

CREATE UNIQUE INDEX croutons_source_hash_uidx
  ON croutons (source_hash)
  WHERE source_hash IS NOT NULL;

COMMIT;