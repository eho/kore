# `@kore/shared-types`

Single source of truth for all Zod schemas and TypeScript interfaces shared across the Kore monorepo. Every package and app imports types from here — nothing is duplicated.

## Exports

### `MemoryTypeEnum`

The four valid memory types used for directory routing:

```ts
import { MemoryTypeEnum } from "@kore/shared-types";
// z.enum(["place", "media", "note", "person"])
```

### `BaseFrontmatterSchema` / `BaseFrontmatter`

Canonical YAML frontmatter schema for every `.md` memory file:

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID v4) | Stable unique identifier for this memory |
| `type` | `MemoryType` | One of `place`, `media`, `note`, `person` |
| `category` | `string` (starts with `qmd://`) | QMD context URI, e.g. `qmd://travel/food/japan` |
| `date_saved` | `string` (ISO datetime) | When the memory was originally saved |
| `source` | `string` | Originating system, e.g. `apple_notes`, `x_bookmark` |
| `tags` | `string[]` (max 5) | Descriptive tags |
| `url` | `string` (URL, optional) | Original URL if applicable |

```ts
import { BaseFrontmatterSchema } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";

const result = BaseFrontmatterSchema.safeParse(myFrontmatter);
if (!result.success) {
  console.error(result.error.issues);
}
```

### `MemoryExtractionSchema` / `MemoryExtraction`

Schema enforcing the structured JSON output from the LLM extraction step:

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Concise declarative title |
| `distilled_items` | `string[]` (1–7) | Atomic facts as standalone sentences |
| `qmd_category` | `string` (starts with `qmd://`) | Hierarchical classification path |
| `type` | `MemoryType` | One of `place`, `media`, `note`, `person` |
| `tags` | `string[]` (max 5, kebab-case) | Lowercase kebab-case tags |

### Plugin Event Interfaces

Used by the plugin system (Phase 2). Defined centrally so consumers can type their plugin hooks:

- **`IngestionContext`** — passed to `onIngestEnrichment` plugin hooks
- **`EnrichmentResult`** — returned by enrichment hooks
- **`MemoryEvent`** — emitted on `memory.indexed`, `memory.deleted`, `memory.updated`
- **`KorePlugin`** — the full plugin interface to implement

## Usage

Add as a workspace dependency in any package or app:

```json
{
  "dependencies": {
    "@kore/shared-types": "workspace:*"
  }
}
```

Then import:

```ts
import {
  BaseFrontmatterSchema,
  MemoryExtractionSchema,
  MemoryTypeEnum,
} from "@kore/shared-types";
import type { BaseFrontmatter, MemoryExtraction, KorePlugin } from "@kore/shared-types";
```

## Development

```sh
# Type check
bun run --filter @kore/shared-types typecheck

# Run tests
bun test packages/shared-types
```
