-- migrations/006_graph_view.sql
-- Creates a view for graph visualization with nodes and links
-- Nodes are unique subjects and objects from triples
-- Links are the triples themselves

CREATE OR REPLACE VIEW v_graph_nodes_links AS
WITH node_set AS (
  SELECT DISTINCT subject AS node_id FROM triples
  UNION
  SELECT DISTINCT object AS node_id FROM triples
),
nodes AS (
  SELECT 
    node_id AS id,
    COUNT(DISTINCT t1.id) + COUNT(DISTINCT t2.id) AS degree
  FROM node_set n
  LEFT JOIN triples t1 ON t1.subject = n.node_id
  LEFT JOIN triples t2 ON t2.object = n.node_id
  GROUP BY node_id
),
links AS (
  SELECT 
    subject AS source,
    object AS target,
    predicate AS label,
    evidence_crouton_id,
    created_at
  FROM triples
)
SELECT 
  jsonb_build_object(
    'nodes', (SELECT jsonb_agg(jsonb_build_object('id', id, 'degree', degree)) FROM nodes),
    'links', (SELECT jsonb_agg(jsonb_build_object('source', source, 'target', target, 'label', label, 'evidence_crouton_id', evidence_crouton_id, 'created_at', created_at)) FROM links)
  ) AS graph_data;

