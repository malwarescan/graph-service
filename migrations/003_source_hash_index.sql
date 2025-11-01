-- Ensure fast/clean dedupe by source_hash
CREATE UNIQUE INDEX IF NOT EXISTS croutons_source_hash_uidx
ON croutons (source_hash)
WHERE source_hash IS NOT NULL;