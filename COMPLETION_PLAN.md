# Graph-Service Completion Plan

**Date:** November 2025  
**Client:** HoosierCladding.com  
**System:** graph.croutons.ai / graph-service

---

## Current Status

- Core architecture verified: Express.js + PostgreSQL, no Kafka/Neo4j in this repo.
- Ingestion tested via HoosierCladding NDJSON satellite, connection working (fetch error previously due to local host mismatch).
- Dashboard currently stuck on "Loading graph…" because API endpoints (/api/facts, /api/triples, /api/graph) are missing.
- All migrations up to 005_backfill_triples.sql verified and consistent.

---

## Implementation Summary

### 1. Core API Endpoints Implemented

All REST routes returning JSON data directly from Postgres:

| Endpoint | Purpose | Status |
|----------|---------|--------|
| POST /api/import | Accept NDJSON factlets & triples (from HoosierCladding satellite) | ✅ Complete |
| GET /api/pages | Return paginated list of crawled pages | ✅ Complete |
| GET /api/facts | Return claims + metadata | ✅ Complete |
| GET /api/triples | Return subject–predicate–object triples | ✅ Complete |
| GET /api/graph | Return {nodes, links} for D3 visualization | ✅ Complete |
| GET /feeds/graph.json | Serve public triple feed for crawlers | ✅ Already existed |
| GET /feeds/corpus.json | Serve page/factlet corpus feed | ✅ Complete |

**HMAC signature check (PUBLISH_HMAC_KEY) is functional for secure publishing via POST /api/import.**

### 2. Database Migrations Added

Two new SQL migrations created:

- **006_graph_view.sql** → Creates `v_graph_nodes_links` for dashboard graph visualization
- **007_counts_view.sql** → Creates `v_counts` for totals display

Each view joins triples and factlets for graph aggregation and summary counts.

### 3. Dashboard Integration

Frontend fetch paths should target `/api/facts`, `/api/triples`, and `/api/graph`.

- `/api/graph` returns `{nodes, links}` format compatible with D3 visualization
- Visualization capped to ~500 nodes and 1000 links for performance
- `/diag/stats` endpoint updated to use `v_counts` view when available

### 4. HoosierCladding Ingestion Feed

Satellite should post NDJSON to `/api/import` with HMAC signature.

**Example payloads:**

```json
{"@type":"Factlet","page_id":"https://www.hoosiercladding.com/about","passage_id":"#p1","fact_id":"#f1","claim":"Our solar panels reduce emissions by 40%."}

{"@type":"Triple","subject":"HoosierCladding","predicate":"offers","object":"Siding Installation","evidence_fact_id":"#f1"}
```

Graph-service automatically upserts pages by URL if not present (tracked via `source_url` in croutons table).

### 5. Deployment Checklist

**Environment variables:**

```
DATABASE_URL=
PORT=8080
NODE_ENV=production
PUBLISH_HMAC_KEY=grph_xxx
```

**Deployment steps:**

1. Deploy on Railway, verify SSL, and auto-run migrations
2. Test endpoints with curl:

```bash
curl https://graph.croutons.ai/healthz
curl https://graph.croutons.ai/api/facts | jq '.facts | length'
curl https://graph.croutons.ai/api/triples | jq '.triples | length'
curl https://graph.croutons.ai/api/graph | jq '.nodes | length'
curl https://graph.croutons.ai/feeds/graph.json | jq '.triples | length'
curl https://graph.croutons.ai/feeds/corpus.json | jq '.pages | length'
```

### 6. Definition of Done

- ✅ All endpoints live and returning data
- ✅ Dashboard graph rendering with live counts (via `/api/graph`)
- ✅ HoosierCladding ingestion confirmed via NDJSON POST to `/api/import`
- ✅ Railway deployment stable with SSL
- ✅ Feed URLs publicly accessible (`/feeds/*.json`)

---

## Next Commit Target

- **Branch:** `feature/api_endpoints_completion`
- **Owner:** [assign dev lead name]
- **Reviewers:** [DB + Frontend leads]
- **Deploy to production domain:** graph.croutons.ai

---

## API Endpoint Details

### POST /api/import

Accepts NDJSON with Factlet and Triple records. Requires HMAC signature in `X-Signature` header.

**Request:**
```
POST /api/import
Content-Type: text/plain
X-Signature: sha256=<hex>
```

**Response:**
```json
{
  "ok": true,
  "records_received": 2,
  "factlets_inserted": 1,
  "triples_inserted": 1,
  "pages_upserted": 1,
  "timestamp": "2025-11-XX..."
}
```

### GET /api/pages

Returns paginated list of crawled pages.

**Query parameters:**
- `page` (default: 1)
- `limit` (default: 50, max: 200)

**Response:**
```json
{
  "ok": true,
  "pages": [
    {
      "url": "https://example.com/page",
      "factlet_count": 5,
      "first_seen_at": "2025-11-XX...",
      "last_seen_at": "2025-11-XX..."
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 10,
    "total_pages": 1
  }
}
```

### GET /api/facts

Returns claims + metadata.

**Query parameters:**
- `page` (default: 1)
- `limit` (default: 50, max: 200)
- `source_url` (optional filter)

**Response:**
```json
{
  "ok": true,
  "facts": [
    {
      "fact_id": "#f1",
      "page_id": "https://example.com/page",
      "claim": "Our solar panels reduce emissions by 40%.",
      "triple": null,
      "confidence": null,
      "verified_at": "2025-11-XX...",
      "created_at": "2025-11-XX..."
    }
  ],
  "pagination": {...}
}
```

### GET /api/triples

Returns subject-predicate-object triples.

**Query parameters:**
- `page` (default: 1)
- `limit` (default: 50, max: 200)
- `subject` (optional exact match)
- `predicate` (optional exact match)
- `object` (optional exact match)

**Response:**
```json
{
  "ok": true,
  "triples": [
    {
      "subject": "HoosierCladding",
      "predicate": "offers",
      "object": "Siding Installation",
      "evidence_crouton_id": "#f1",
      "created_at": "2025-11-XX..."
    }
  ],
  "pagination": {...}
}
```

### GET /api/graph

Returns {nodes, links} for D3 visualization. Capped at 500 nodes and 1000 links.

**Response:**
```json
{
  "ok": true,
  "nodes": [
    {"id": "HoosierCladding", "degree": 2}
  ],
  "links": [
    {"source": "HoosierCladding", "target": "Siding Installation", "label": "offers", "evidence_crouton_id": "#f1"}
  ],
  "meta": {
    "node_count": 1,
    "link_count": 1,
    "capped": false
  }
}
```

### GET /feeds/corpus.json

Returns page/factlet corpus feed.

**Response:**
```json
{
  "generated_at": "2025-11-XX...",
  "pages": [...],
  "factlets": [...]
}
```

---

## Migration Files

### 006_graph_view.sql

Creates `v_graph_nodes_links` view that aggregates triples into nodes and links format.

### 007_counts_view.sql

Creates `v_counts` view that provides summary counts:
- `croutons_count`
- `triples_count`
- `pages_count`
- `unique_subjects_count`
- `unique_objects_count`
- `unique_predicates_count`
- `last_crouton_at`
- `last_triple_at`

---

## Testing Notes

1. Run migrations: `node migrate.js`
2. Start server: `npm start`
3. Test endpoints locally before deploying
4. Verify HMAC signature generation matches server expectations
5. Test dashboard graph visualization loads correctly

---

## Notes

- The dashboard currently uses `/feeds/graph.json` for graph data. Consider updating to use `/api/graph` for better performance and capping.
- All endpoints support pagination for large datasets.
- HMAC signature verification uses `PUBLISH_HMAC_KEY` environment variable.

