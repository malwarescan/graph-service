-- migrations/007_counts_view.sql
-- Creates a view for summary counts across croutons, triples, and pages

CREATE OR REPLACE VIEW v_counts AS
SELECT 
  (SELECT COUNT(*)::int FROM croutons) AS croutons_count,
  (SELECT COUNT(*)::int FROM triples) AS triples_count,
  (SELECT COUNT(DISTINCT source_url)::int FROM croutons) AS pages_count,
  (SELECT COUNT(DISTINCT subject)::int FROM triples) AS unique_subjects_count,
  (SELECT COUNT(DISTINCT object)::int FROM triples) AS unique_objects_count,
  (SELECT COUNT(DISTINCT predicate)::int FROM triples) AS unique_predicates_count,
  (SELECT MAX(created_at) FROM croutons) AS last_crouton_at,
  (SELECT MAX(created_at) FROM triples) AS last_triple_at;

