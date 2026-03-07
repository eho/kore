# Kore Plugin Architecture & System Contract

The Kore Core Engine provides a lightweight, event-driven, extensible framework that allows specialized logic to be injected into the ingestion and storage lifecycle without bloating the main codebase.

This document defines the formal contract for building and registering a Kore Plugin.

---

## 1. The `KorePlugin` Interface

Every plugin in Kore must implement the base `KorePlugin` interface. This ensures the core engine knows how to initialize, route, and dispatch events to the plugin.

```typescript
import type { Elysia } from 'elysia';

export interface KorePlugin {
  /**
   * The unique identifier for the plugin (e.g., 'spatialite', 'synthesis')
   */
  name: string;

  /**
   * Optional: Expose custom REST API routes on the core Elysia engine.
   * Prefix should ideally be `/plugins/${name}`.
   */
  routes?: (app: Elysia) => Elysia;

  /**
   * Optional: Hook into the ingestion pipeline BEFORE the markdown file is written.
   * This is where a plugin can extract specialized metadata (e.g., GPS coords).
   */
  onIngestEnrichment?: (context: IngestionContext) => Promise<EnrichmentResult | void>;

  /**
   * Lifecycle Event: Fired AFTER the Core Engine has written the new memory .md file
   * and updated the base QMD index. Useful for side-effect tracking (e.g. updating Spatialite DB).
   */
  onMemoryIndexed?: (event: MemoryEvent) => Promise<void>;

  /**
   * Lifecycle Event: Fired AFTER a memory has been deleted from the core system.
   * Plugins MUST use this to clean up their own isolated state.
   */
  onMemoryDeleted?: (event: MemoryEvent) => Promise<void>;

  /**
   * Lifecycle Event: Fired AFTER a memory .md file is updated.
   */
  onMemoryUpdated?: (event: MemoryEvent) => Promise<void>;
}
```

---

## 2. Event Payloads and Context Shapes

To ensure strong typing throughout the Monorepo, plugins consume these standard interfaces:

### `IngestionContext` (Pre-Storage)
Used during `onIngestEnrichment` to allow plugins to see what the core LLM has already extracted and append their own metadata.

```typescript
export interface IngestionContext {
  id: string;                      // The UUID representing this new memory
  rawText: string;                 // The raw text scraped from the source
  source: string;                  // e.g., 'apple_notes', 'safari_bookmark'
  coreCategorization: {            // Base extraction already performed by core LLM
    categories: string[];
    tags: string[];
  };
}

export interface EnrichmentResult {
  // Any key-value pairs returned here will be merged into the .md YAML frontmatter
  frontmatterExtensions?: Record<string, any>;
  // Distinct atomic facts that should be appended to the "Distilled Memory Items" markdown section
  additionalMemoryItems?: string[]; 
}
```

### `MemoryEvent` (Post-Storage Lifecycle)
Used when broadcasting `onMemoryIndexed`, `onMemoryDeleted`, or `onMemoryUpdated`.

```typescript
export interface MemoryEvent {
  id: string;                      // The UUID of the memory
  filePath: string;                // Absolute path to the .md file (e.g., '/Users/eho/kore-data/places/abc.md')
  frontmatter: Record<string, any>;// The fully parsed YAML header of the saved file
  timestamp: string;               // ISO 8601 timestamp of the event
}
```

---

## 3. Plugin Registration

Plugins are registered at engine startup. The core ElysiaJS server acts as the dispatcher.

**Example `apps/core-api/src/index.ts`:**

```typescript
import { Elysia } from 'elysia';
import { CoreEngine } from './engine';
import { SpatialitePlugin } from '@kore/plugin-spatialite';
import { SynthesisPlugin } from '@kore/plugin-synthesis';

const app = new Elysia();
const engine = new CoreEngine();

// Array of activated plugins
const plugins: KorePlugin[] = [
  new SpatialitePlugin(),
  new SynthesisPlugin()
];

// Mount plugin specific routes
plugins.forEach(plugin => {
  if (plugin.routes) {
    app.use(plugin.routes);
  }
});

// Register plugins with the Event Dispatcher / Hook pipeline
engine.registerPlugins(plugins);

app.listen(3000, () => {
    console.log(`Kore Core API listening on port 3000`);
});
```

---

## 4. Architectural Rules for Plugin Authors

To prevent the core system from degrading, plugins must adhere to these constraints:

1. **State Synchronization:** If your plugin maintains its own database (e.g., a SQL table tracking geographic locations), it **MUST** implement the `onMemoryDeleted` and `onMemoryUpdated` lifecycle hooks to ensure its proprietary database perfectly mirrors the existence of files in the file system.
2. **Non-Blocking Hooks:** The `onIngestEnrichment` hook is the only pipeline step that can block the creation of the `.md` file. Native plugin LLM calls here should be highly targeted, small-parameter, or structured to avoid slowing down base ingestion.
3. **Fail-Safe Execution:** Lifecycle events (`onMemoryIndexed`) are dispatched asynchronously. If a plugin throws an error during event processing, the core engine logs the failure but **does not** crash or rollback the primary markdown file creation. Plugins are responsible for their own retry mechanisms if critical.
