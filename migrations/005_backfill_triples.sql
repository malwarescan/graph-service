-- Backfill triples from existing croutons that already have triple JSON
INSERT INTO public.triples (subject, predicate, object, evidence_crouton_id)
SELECT DISTINCT
  (croutons.triple->>'subject') AS subject,
  (croutons.triple->>'predicate') AS predicate,
  (croutons.triple->>'object') AS object,
  croutons.crouton_id
FROM public.croutons
WHERE croutons.triple IS NOT NULL
  AND (croutons.triple->>'subject') IS NOT NULL
  AND (croutons.triple->>'predicate') IS NOT NULL
  AND (croutons.triple->>'object') IS NOT NULL
ON CONFLICT (subject, predicate, object) DO NOTHING;