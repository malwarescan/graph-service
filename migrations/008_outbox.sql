-- migrations/008_outbox.sql
-- Creates outbox table and triggers for change capture from triples and factlets

CREATE TABLE IF NOT EXISTS outbox_graph_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'triple.insert', 'factlet.insert', etc.
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_graph_events (status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outbox_event_type ON outbox_graph_events (event_type);

-- Trigger function for triple inserts
CREATE OR REPLACE FUNCTION fn_outbox_triple_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO outbox_graph_events(event_type, payload)
  VALUES ('triple.insert', jsonb_build_object(
    'id', NEW.id::text,
    'subject', NEW.subject,
    'predicate', NEW.predicate,
    'object', NEW.object,
    'evidence_crouton_id', NEW.evidence_crouton_id,
    'created_at', NEW.created_at
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for factlet (crouton) inserts
CREATE OR REPLACE FUNCTION fn_outbox_factlet_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO outbox_graph_events(event_type, payload)
  VALUES ('factlet.insert', jsonb_build_object(
    'id', NEW.id::text,
    'crouton_id', NEW.crouton_id,
    'source_url', NEW.source_url,
    'text', NEW.text,
    'corpus_id', NEW.corpus_id,
    'created_at', NEW.created_at
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trg_outbox_triple_insert ON triples;
DROP TRIGGER IF EXISTS trg_outbox_factlet_insert ON croutons;

-- Create triggers
CREATE TRIGGER trg_outbox_triple_insert
AFTER INSERT ON triples
FOR EACH ROW EXECUTE FUNCTION fn_outbox_triple_insert();

CREATE TRIGGER trg_outbox_factlet_insert
AFTER INSERT ON croutons
FOR EACH ROW EXECUTE FUNCTION fn_outbox_factlet_insert();

