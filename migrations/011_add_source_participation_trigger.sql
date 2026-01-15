-- migrations/011_add_source_participation_trigger.sql
-- Add source tracking schema and trigger for outbox events

-- Create source_tracking schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS source_tracking;

-- Create trigger for source participation events to outbox
CREATE OR REPLACE FUNCTION source_tracking.notify_source_participation()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO outbox_graph_events (event_type, payload, occurred_at)
  SELECT 
    'source_participation.insert'::text,
    json_build_object(
      'crouton_id', NEW.crouton_id::text,
      'source_domain', NEW.source_domain,
      'source_url', NEW.source_url,
      'ai_readable_source', NEW.ai_readable_source,
      'markdown_discovered', NEW.markdown_discovered,
      'discovery_method', NEW.discovery_method,
      'first_observed', NEW.first_observed,
      'last_verified', NEW.last_verified
    ),
    NOW()
  WHERE NEW.ai_readable_source = true OR NEW.markdown_discovered = true;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for source participation only if table exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'source_tracking' 
        AND table_name = 'source_participation'
    ) THEN
        DROP TRIGGER IF EXISTS notify_source_participation_trigger ON source_tracking.source_participation;
        CREATE TRIGGER notify_source_participation_trigger
        AFTER INSERT OR UPDATE ON source_tracking.source_participation
        FOR EACH ROW
        EXECUTE FUNCTION source_tracking.notify_source_participation();
    END IF;
END
$$;

-- Note: source_participation table will be created by main API migration
-- This trigger will become active once both schemas are synced
