# Kore Project Assessment

**Date:** 2026-03-21
**Scope:** Vision, Phase 1 & Phase 2 design/plans vs implementation alignment, dead code, duplicates, code quality, and future directions.

---

## 1. Vision-to-Implementation Alignment

**Verdict: Strong alignment.** Phase 1 (MVP) and Phase 2 (Consolidation + MCP + Apple Notes) are both fully implemented and match the design docs closely.

| Design Area | Status | Notes |
|---|---|---|
| Passive Ingestion Pipeline | Complete | Queue, worker, LLM extraction, file watcher |
| Agentic Retrieval (MCP) | Complete | All 6 tools, embedded + stdio proxy |
| Consolidation System | Complete | All lifecycle states, reactive re-synthesis, dedup/supersession |
| CLI Alignment | Complete | All commands use operations layer, `--json` flags, new filter flags |
| Apple Notes Plugin | Complete | Sync loop, manifest diffing, content builder, external key registry |
| Data Schema (Zod) | Complete | BaseFrontmatter, InsightFrontmatter, MemoryExtraction all match spec |
| Plugin Architecture | Complete | Lifecycle methods, event dispatch, registry |

**Minor gap:** The `listExternalKeys()` on `PluginStartDeps` was flagged in the design as a gap, but is actually wired correctly in `index.ts:121-129`.

---

## 2. Dead Code & Duplicate Components

### High Priority: 4 Deprecated REST Endpoints

`apps/core-api/src/app.ts` still has old endpoints that are fully superseded by the operations layer:

| Old Endpoint | Replacement |
|---|---|
| `POST /api/v1/search` | `POST /api/v1/recall` |
| `POST /api/v1/ingest/raw` | `POST /api/v1/remember` |
| `GET /api/v1/memory/:id` | `GET /api/v1/inspect/:id` |
| `GET /api/v1/memories` | `POST /api/v1/recall` (no query) |

These carry their own inline parsing logic that duplicates the operations layer.

### Medium Priority: Duplicate `parseFrontmatter()`

This function is duplicated in **6+ files**: `app.ts`, `consolidation-loop.ts`, `consolidation-event-handlers.ts`, `delete-memory.ts`, `operations/inspect.ts`, `consolidation-writer.ts`. Should be extracted to a shared `lib/frontmatter.ts`.

### Medium Priority: Duplicate `fallbackParse()`

`consolidation-synthesizer.ts` contains an identical copy of `fallbackParse()` from `@kore/llm-extractor`. Should import instead.

### Low Priority: Dead/Unused Code

| Item | Location | Status |
|---|---|---|
| `worker-entry.ts` | `apps/core-api/src/` | Dead — no references in scripts, Docker, or imports |
| `addCollection()`, `addContext()` | `packages/qmd-client/` | Exported but never called |
| `IngestionContext`, `EnrichmentResult` | `packages/shared-types/` | Interface-only, enrichment not implemented |

### CLI Commands Using Old Endpoints

- `kore list` still calls `GET /api/v1/memories` — should migrate to `POST /api/v1/recall`

---

## 3. Code Quality Issues

### Architecture

- **`app.ts` is 706 lines** — all 17 route handlers are inline. Should extract to `routes/` modules.
- **`consolidation-loop.ts` is 756 lines** — mixes helpers, cycle logic, dry-run, and loop orchestration. Should split into 2-3 files.

### Error Handling

- **7 silent catch blocks** in `consolidation-loop.ts` swallow errors without logging. Debugging consolidation failures will be difficult.
- **Inconsistent error patterns** in `app.ts` — some catch blocks log, some don't, some return errors differently.

### Configuration

- **Port 3000 is hardcoded** in `index.ts:212`. Should be `KORE_PORT` env var.
- Several consolidation thresholds (cluster size, similarity score) have hardcoded defaults — should be env-configurable for tuning.

### TypeScript

- **~51 uses of `any`** across the codebase, mostly in frontmatter parsing and MCP tool handlers. A shared `FrontmatterFields` type would eliminate most of these.

### Documentation Drift

- `apps/core-api/README.md` shows an outdated health endpoint response structure that doesn't match current implementation.

---

## 4. Future Directions

### Refactoring (Recommended First)

1. **Remove deprecated endpoints + duplicate parsing** — single biggest cleanup. Reduces `app.ts` by ~200 lines and eliminates the maintenance burden of two code paths.
2. **Extract shared `parseFrontmatter()` utility** — one module, used everywhere.
3. **Split large files** — `app.ts` routes into modules, `consolidation-loop.ts` into logical units.
4. **Configurable port + thresholds** — small change, big operational flexibility.

### Optimization

5. **Batch worker processing** — currently processes 1 task per 5s poll. Could batch multiple tasks per cycle for higher throughput (especially useful during Apple Notes bulk sync).
6. **Incremental QMD updates** — watcher currently triggers a full `qmd.update()` on any change. Could pass specific changed file paths for targeted re-indexing.
7. **Connection pooling for SQLite** — queue, tracker, and plugin registry all open separate connections. A shared connection pool with WAL mode could reduce contention.
8. **Smarter consolidation scheduling** — instead of fixed 30-min intervals, could use event-driven scheduling (consolidate when N new memories arrive since last cycle).

### New Features

9. **Push channel (proactive nudges)** — the big vision piece still unbuilt. Location-aware notifications when near saved places, time-based reminders for travel. Core infrastructure: geofencing via Spatialite plugin + notification delivery (OS notifications, Telegram bot, etc.).
10. **Browser extension / web clipper** — passive ingestion from Safari/Chrome. Would use the existing `POST /api/v1/remember` endpoint. Low implementation cost, high value for expanding the ingestion surface.
11. **X / Reddit / Pocket API integrations** — scheduled cron jobs calling APIs, feeding into the ingestion pipeline. Architecture already supports this via the plugin system.
12. **Multi-modal extraction** — vision model support for image attachments (Apple Notes photos, screenshots). The content builder already preserves `[Attachment: filename]` placeholders that could be re-processed.
13. **Chunking for long notes** — notes >8000 chars are currently truncated. Could chunk into multiple memories with cross-references, improving extraction quality.
14. **Knowledge graph visualization** — export memory relationships (insight_refs, source_ids, connections) as a graph for power users. Could use D3 or a simple web UI.
15. **Manual feedback on insights** — let users upvote/downvote insights to tune confidence and guide future consolidation. The `reinforcement_count` field already exists.
16. **Real-time consolidation** — instead of batch cycles, trigger consolidation immediately when a new memory is semantically close to an existing cluster. The event handler infrastructure already flags related insights.
17. **Multi-device sync** — replicate the `$KORE_HOME/data/` directory via iCloud Drive, Syncthing, or git. Markdown-native storage makes this straightforward.
18. **Embedding model upgrade** — support swappable embedding models (OpenAI ada, local sentence-transformers) for better semantic search quality.

### Architecture Evolution

19. **HTTP to WebSocket for CLI** — the CLI currently polls for task status. A WebSocket connection could stream progress in real-time.
20. **Structured logging** — replace `console.log` calls with structured JSON logging (pino/winston) for better observability and log aggregation.
21. **Metrics endpoint** — expose Prometheus-compatible metrics (ingestion rate, consolidation stats, queue depth) for monitoring.

---

## Summary

The project is **well-built and highly aligned with its design vision**. Phase 1 and Phase 2 are complete and passing 826 tests. The main technical debt is the legacy endpoint layer in `app.ts` and scattered code duplication — both straightforward to clean up. The most impactful next steps are (1) the refactoring cleanup to reduce maintenance burden, and (2) the push channel / proactive nudges feature, which is the most differentiated part of the vision that hasn't been built yet.
