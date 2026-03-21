# Activity Tracker Design

**Status:** Draft
**Date:** 2026-03-19

## Problem Statement

The Kore server runs multiple background subsystems (worker, embedder, watcher, consolidation loop, plugin sync loops). When the server is busy, there is no way to determine **what it is currently doing**. `kore health` reports queue length and QMD index status but not which operations are in flight or how long they have been running.

This makes it difficult to diagnose:
- Why the server is still busy after ingestion completes (is it the embedder? consolidation? watcher cascade?)
- Whether an operation is making progress or is blocked behind the QMD lock
- Whether the server is idle and safe to shut down

## Design Goals

1. Report currently active operations via `kore health` with name, phase detail, and duration
2. Minimal integration cost — each subsystem adds 2-3 lines, no structural changes
3. Pure in-memory — no database tables, no persistence, resets on restart
4. Optional dependency — subsystems work unchanged in tests when no tracker is provided

## Non-Goals

- Historical operation log / metrics (use structured log files for that)
- Lock-level tracking (which subsystem holds the QMD `withLock`) — this is a follow-up if phase-level detail proves insufficient
- Plugin instrumentation (Apple Notes sync) — deferred; requires extending `PluginStartDeps`

---

## Architecture

### ActivityTracker Class

New file: `apps/core-api/src/activity-tracker.ts`

```typescript
export interface ActiveOperation {
  name: string;
  detail?: string;
  startedAt: string;    // ISO 8601
  durationSec: number;  // seconds since start, computed at query time
}

export class ActivityTracker {
  private ops = new Map<string, {
    name: string;
    detail?: string;
    startedAt: number;   // Date.now()
  }>();

  /** Register the start of an operation. */
  start(id: string, name: string, detail?: string): void {
    this.ops.set(id, { name, detail, startedAt: Date.now() });
  }

  /** Update the phase/detail of a running operation. */
  update(id: string, detail: string): void {
    const op = this.ops.get(id);
    if (op) op.detail = detail;
  }

  /** Mark an operation as complete (removes it from active set). */
  finish(id: string): void {
    this.ops.delete(id);
  }

  /** Return all currently active operations with computed durations. */
  getActive(): ActiveOperation[] {
    const now = Date.now();
    return [...this.ops.values()].map(op => ({
      name: op.name,
      detail: op.detail,
      startedAt: new Date(op.startedAt).toISOString(),
      durationSec: Math.round((now - op.startedAt) / 1000),
    }));
  }
}
```

### Lifecycle

- One `ActivityTracker` instance is created in `index.ts` alongside the other shared deps (`queue`, `memoryIndex`, `eventDispatcher`).
- Passed as an **optional** dep (`tracker?: ActivityTracker`) to each subsystem.
- Subsystems call `tracker?.start()`, `tracker?.update()`, `tracker?.finish()` around their main work.
- The health route queries `tracker.getActive()` and includes the result in the response.

---

## Instrumentation Points

### Embedder (`embedder.ts`)

Add `tracker?: ActivityTracker` to `EmbedderDeps`.

```typescript
// Inside the setInterval callback:
tracker?.start("embedder", "embedder", "starting embed cycle");
try {
  const result = await embedFn();
  tracker?.update("embedder", `embed complete (${result.docs} docs, ${result.chunks} chunks)`);
} catch (err) {
  // existing error handling
} finally {
  tracker?.finish("embedder");
}
```

**Phase transitions:**
| Phase detail | Meaning |
|---|---|
| `"starting embed cycle"` | About to call QMD embed |
| `"embed complete (N docs, M chunks)"` | Brief window before finish; visible only if health is polled at exact moment |

### Watcher (`watcher.ts`)

Add `tracker?: ActivityTracker` to `WatcherDeps`.

```typescript
// Inside the debounce setTimeout callback, around updateFn():
tracker?.start("watcher", "watcher", "QMD update");
try {
  const result = await updateFn();
  // existing logging and cooldown logic
} catch (err) {
  // existing error handling
} finally {
  tracker?.finish("watcher");
}
```

**Phase transitions:**
| Phase detail | Meaning |
|---|---|
| `"QMD update"` | Calling QMD update to re-index changed files |

### Worker (`worker.ts`)

Add `tracker?: ActivityTracker` to `WorkerDeps`.

```typescript
// Inside pollOnce(), after dequeueAndLock() succeeds:
deps.tracker?.start("worker", "worker", `task ${task.id} (${payload.source})`);
try {
  deps.tracker?.update("worker", `LLM extraction: ${task.id} (${payload.source})`);
  const result = await processTask(task.id, payload, deps);
  deps.tracker?.update("worker", `writing file: ${task.id}`);
  // existing memoryIndex.set(), dispatcher.emit()
} catch (err) {
  // existing error handling
} finally {
  deps.tracker?.finish("worker");
}
```

**Phase transitions:**
| Phase detail | Meaning |
|---|---|
| `"task {id} ({source})"` | Task dequeued, about to process |
| `"LLM extraction: {id} ({source})"` | Calling LLM extractor |
| `"writing file: {id}"` | LLM done, writing markdown to disk |

### Consolidation Loop (`consolidation-loop.ts`)

Add `tracker?: ActivityTracker` to `ConsolidationDeps`.

```typescript
// Inside runConsolidationCycle():
deps.tracker?.start("consolidation", "consolidation", "selecting seed");

// After seed selected:
deps.tracker?.update("consolidation", `seed: "${seed.title}"`);

// Before QMD search:
deps.tracker?.update("consolidation", `QMD search for "${seed.title}"`);

// After candidates found:
deps.tracker?.update("consolidation", `${candidates.length} candidates, validating cluster`);

// Before LLM synthesis:
deps.tracker?.update("consolidation", `LLM synthesis (${clusterSize} sources)`);

// In finally block or at each return point:
deps.tracker?.finish("consolidation");
```

**Phase transitions:**
| Phase detail | Meaning |
|---|---|
| `"selecting seed"` | Querying tracker for eligible seed |
| `"seed: \"{title}\""` | Seed selected, loading memory |
| `"QMD search for \"{title}\""` | Semantic search for related memories |
| `"{N} candidates, validating cluster"` | Evaluating cluster quality |
| `"LLM synthesis ({N} sources)"` | Calling LLM to generate insight |

### Bootstrap (`index.ts`)

The initial QMD update + embed that runs when the index is empty on startup:

```typescript
tracker.start("bootstrap", "bootstrap", "QMD update (initial index)");
await qmdClient.update();
tracker.update("bootstrap", "QMD embed (initial vectors)");
await qmdClient.embed();
tracker.finish("bootstrap");
```

---

## Health Endpoint Changes

### API Response (`app.ts`)

Add `tracker?: ActivityTracker` to `AppDeps`.

```typescript
.get("/api/v1/health", async () => {
  const qmd = await qmdStatus();
  return {
    status: "ok",
    version: "1.0.0",
    qmd,
    queue_length: queue.getQueueLength(),
    active_operations: tracker?.getActive() ?? [],
  };
})
```

### HealthResponse Type (CLI)

Update `HealthResponse` interface in `apps/cli/src/commands/health.ts`:

```typescript
interface HealthResponse {
  status: string;
  version: string;
  qmd: {
    status: string;
    doc_count?: number;
    collections?: number;
    needs_embedding?: number;
  };
  queue_length: number;
  active_operations?: Array<{
    name: string;
    detail?: string;
    startedAt: string;
    durationSec: number;
  }>;
}
```

### CLI Display

Add an "Active Operations" section to the `kore health` output:

```typescript
// After the existing output lines:
if (result.data.active_operations?.length) {
  lines.push("");
  lines.push(pc.bold("Active Operations:"));
  for (const op of result.data.active_operations) {
    const dur = formatDuration(op.durationSec);
    const detail = op.detail ? pc.dim(` — ${op.detail}`) : "";
    lines.push(`  ${pc.cyan(op.name.padEnd(18))}${detail}  ${pc.yellow(dur)}`);
  }
} else {
  lines.push("");
  lines.push(pc.dim("Active Operations: (none)"));
}
```

Helper:
```typescript
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
```

---

## Example Output

### During ingestion (worker + embedder both busy)

```
API Status:   ok
Version:      1.0.0
QMD Status:   ok (docs: 272, collections: 1, needs embedding: 45)
Queue Length: 12

Active Operations:
  worker             — LLM extraction: abc123 (apple_notes)  2s
  embedder           — starting embed cycle                   4m 12s
```

### During consolidation cycle

```
API Status:   ok
Version:      1.0.0
QMD Status:   ok (docs: 272, collections: 1)
Queue Length: 0

Active Operations:
  consolidation      — LLM synthesis (5 sources)  14s
```

### Server idle

```
API Status:   ok
Version:      1.0.0
QMD Status:   ok (docs: 272, collections: 1)
Queue Length: 0

Active Operations: (none)
```

### JSON mode (`kore health --json`)

```json
{
  "status": "ok",
  "version": "1.0.0",
  "qmd": {
    "status": "ok",
    "doc_count": 272,
    "collections": 1,
    "needs_embedding": 0
  },
  "queue_length": 0,
  "active_operations": [
    {
      "name": "embedder",
      "detail": "starting embed cycle",
      "startedAt": "2026-03-19T09:44:38.000Z",
      "durationSec": 312
    }
  ]
}
```

---

## Files Changed

| File | Change |
|---|---|
| `apps/core-api/src/activity-tracker.ts` | **New** — `ActivityTracker` class (~40 lines) |
| `apps/core-api/src/activity-tracker.test.ts` | **New** — unit tests for start/update/finish/getActive |
| `apps/core-api/src/embedder.ts` | Add `tracker?` to deps, wrap embed call |
| `apps/core-api/src/watcher.ts` | Add `tracker?` to deps, wrap updateFn call |
| `apps/core-api/src/worker.ts` | Add `tracker?` to deps, wrap pollOnce phases |
| `apps/core-api/src/consolidation-loop.ts` | Add `tracker?` to deps, update phases through cycle |
| `apps/core-api/src/index.ts` | Create tracker instance, pass to all subsystems + app + bootstrap |
| `apps/core-api/src/app.ts` | Add `tracker?` to `AppDeps`, include in health response |
| `apps/cli/src/commands/health.ts` | Extend `HealthResponse`, add Active Operations display |

## Testing Strategy

### Unit Tests (`activity-tracker.test.ts`)

- `start()` + `getActive()` returns the operation with correct name, detail, and a positive durationSec
- `update()` changes the detail field without affecting startedAt
- `finish()` removes the operation from the active set
- Multiple concurrent operations are tracked independently
- `getActive()` on empty tracker returns `[]`
- `finish()` on unknown id is a no-op (no throw)

### Existing Test Compatibility

All subsystem deps interfaces add `tracker` as **optional** (`tracker?: ActivityTracker`). Existing tests pass unchanged — they don't provide a tracker, so `tracker?.start()` etc. are no-ops.

No changes to existing test files are required (beyond the watcher/worker tests already modified in this session).

---

## Future Extensions

### Lock-aware tracking (Option B follow-up)

If phase-level detail proves insufficient for diagnosing blocked operations:

- Add `onAcquire(holder: string)` / `onRelease()` callbacks to `withLock` in `@kore/qmd-client`
- The tracker would show `"waiting for QMD lock"` vs `"QMD embed"` explicitly
- Requires subsystems to pass their ID when calling QMD operations

### Plugin instrumentation

- Add `tracker?: ActivityTracker` to `PluginStartDeps` in `shared-types`
- Apple Notes sync loop calls `tracker?.start("apple-notes-sync", ...)` around its sync cycle
- Other plugins can opt-in similarly
