-- 004_triples_unique.sql
-- Ensure triples are idempotent on (subject,predicate,object)

ALTER TABLE IF EXISTS public.triples
  ADD CONSTRAINT triples_unique_subject_predicate_object
  UNIQUE (subject, predicate, object);