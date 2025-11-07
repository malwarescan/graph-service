# Deployment Runbook (Graph-Service + Graph-Indexer)

## 0. Prereqs

- Postgres reachable (same DB used by graph-service)
- Neo4j reachable (bolt+s) with creds
- Domains: graph.croutons.ai (service), optional indexer subdomain not required

---

## 1. Deploy graph-service (Railway)

### Environment Variables

```
DATABASE_URL=postgres://...
PORT=8080
NODE_ENV=production
PUBLISH_HMAC_KEY=grph_****************
```

### Steps

1. **Build & deploy graph-service.**

2. **Run migrations:**

```bash
cd graph-service
node migrate.js
```

3. **Smoke test:**

```bash
curl -s https://graph.croutons.ai/healthz
curl -s https://graph.croutons.ai/feeds/graph.json | jq '.triples | length'
curl -s https://graph.croutons.ai/api/triples?limit=5 | jq .
curl -s https://graph.croutons.ai/diag/stats | jq .
```

---

## 2. Initialize Neo4j

From `graph-indexer/`:

```bash
node scripts/setup-neo4j-constraints.js
```

Confirms uniqueness constraints on Entity, WebPage, Factlet (and Fact if you added it later).

### Environment Variables

```
NEO4J_URI=bolt+s://<host>:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=********
```

---

## 3. Seed Outbox (Backfill)

In graph-service DB:

- Ensure migration `008_outbox.sql` applied (table + triggers present).

From `graph-indexer/`:

```bash
node scripts/backfill-outbox.js
```

This inserts missing historical `triple.insert` events into `outbox_graph_events` (idempotent).

### Verification (Postgres)

```bash
psql $DATABASE_URL -c "SELECT status, count(*) FROM outbox_graph_events GROUP BY 1 ORDER BY 1;"
```

---

## 4. Deploy graph-indexer (Railway)

### Environment Variables

```
DATABASE_URL=postgres://...
NEO4J_URI=bolt+s://<host>:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=********
BATCH_SIZE=500
POLL_INTERVAL_MS=2000
```

### Start

```bash
npm start
```

Logs should show batched claims → processed → done.

---

## 5. End-to-End Verification

### Postgres

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM triples;"
psql $DATABASE_URL -c "SELECT status, count(*) FROM outbox_graph_events GROUP BY 1 ORDER BY 1;"
```

### Neo4j (Cypher)

```cypher
MATCH (e:Entity) RETURN count(e);

MATCH (s:Entity)-[r:ASSERTS]->(o:Entity)
RETURN s.name, r.predicate, o.name
LIMIT 10;
```

### Graph-Service Feeds / API

```bash
curl -s https://graph.croutons.ai/feeds/graph.json | jq '.triples | length'
curl -s https://graph.croutons.ai/api/graph | jq '.nodes | length, .links | length'
```

### Dashboard

- Open https://graph.croutons.ai/dashboard
- Confirm counts match `/diag/stats`
- Confirm graph renders (≤500 nodes, ≤1000 links)

---

## 6. Live Ingestion (HoosierCladding)

Point satellite to:

```
POST https://graph.croutons.ai/api/import
Headers: X-Signature: sha256=<hmac(body, PUBLISH_HMAC_KEY)>
Body: NDJSON (Factlet / Triple)
```

### Smoke Test Import

```bash
curl -s -X POST https://graph.croutons.ai/api/import \
  -H "X-Signature: sha256:<hex>" \
  --data-binary @sample.ndjson | jq .
```

Then verify:

- `/api/triples` shows the new triple
- Neo4j shows a new ASSERTS edge

---

## 7. Monitoring & Ops

### Indexer Health

**Backlog check:**

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM outbox_graph_events WHERE status IN ('pending','failed');"
```

**If failed > 0:**

```bash
psql $DATABASE_URL -c "SELECT id,event_type,error,attempts FROM outbox_graph_events WHERE status='failed' ORDER BY occurred_at ASC LIMIT 50;"
```

Fix cause, then requeue:

```sql
UPDATE outbox_graph_events
SET status='pending', attempts=0, error=null
WHERE status='failed';
```

### Throughput Sanity

**Oldest pending age:**

```sql
SELECT now() - min(occurred_at) AS oldest_pending_age
FROM outbox_graph_events
WHERE status='pending';
```

---

## 8. Rollback Plan

- **Indexer:** Stop the indexer service; Neo4j remains intact.
- **Graph-service:** Revert to previous image; DB schema is forward-compatible (outbox table is inert if unused).
- **Data consistency:** MERGE + deterministic IDs keep Neo4j idempotent; replays are safe.

---

## 9. What "Done" Looks Like

- ✅ Dashboard live with current counts and graph.
- ✅ `/feeds/graph.json` and `/api/*` endpoints returning data.
- ✅ Outbox drains continuously (no growing backlog).
- ✅ New HoosierCladding facts appear in both Postgres APIs and Neo4j within seconds.

---

## Quick Reference Checklist

- [ ] Graph-service deployed and migrations applied
- [ ] Graph-service endpoints responding (`/healthz`, `/api/*`, `/feeds/*`)
- [ ] Neo4j constraints created
- [ ] Outbox backfilled with historical data
- [ ] Graph-indexer deployed and running
- [ ] Outbox draining (pending count decreasing)
- [ ] Neo4j entities and relationships present
- [ ] Dashboard rendering graph
- [ ] Live ingestion tested (HoosierCladding satellite)

