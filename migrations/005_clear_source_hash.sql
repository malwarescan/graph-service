-- Clear all source_hash values to avoid unique constraint conflicts
-- This allows the new code (which uses NULL) to work properly
UPDATE croutons SET source_hash = NULL WHERE source_hash IS NOT NULL;

