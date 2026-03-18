# `@kore/shared-types`

Single source of truth for all Zod schemas and TypeScript interfaces shared across the Kore monorepo. Every package and app imports types from here — nothing is duplicated.

## Exports

### `MemoryTypeEnum`

The five valid memory types used for directory routing:

```ts
import { MemoryTypeEnum } from "@kore/shared-types";
// z.enum(["place", "media", "note", "person", "insight"])
```

### `BaseFrontmatterSchema` / `BaseFrontmatter`

Canonical YAML frontmatter schema for every `.md` memory file:

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID v4) | Stable unique identifier for this memory |
| `type` | `MemoryType` | One of `place`, `media`, `note`, `person`, `insight` |
| `category` | `string` (starts with `qmd://`) | QMD context URI, e.g. `qmd://travel/food/japan` |
| `date_saved` | `string` (ISO datetime) | When the memory was originally saved |
| `source` | `string` | Originating system, e.g. `apple_notes`, `x_bookmark` |
| `tags` | `string[]` (max 5) | Descriptive tags |
| `url` | `string` (URL, optional) | Original URL if applicable |
| `intent` | `IntentEnum` (optional) | Intent/disposition of the memory |
| `confidence` | `number` (0-1, optional) | LLM extraction confidence score |
| `consolidated_at` | `string` (ISO datetime, optional) | When this memory was last used in consolidation |
| `insight_refs` | `string[]` (optional) | IDs of insights that reference this memory |

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
| `type` | `MemoryType` | One of `place`, `media`, `note`, `person` (never `insight` — LLM extraction excludes it) |
| `tags` | `string[]` (max 5, kebab-case) | Lowercase kebab-case tags |

### Insight Schemas (Consolidation System)

Schemas for the consolidation system's insight files. Insights are synthesized from clusters of related memories.

#### `InsightTypeEnum`

```ts
import { InsightTypeEnum } from "@kore/shared-types";
// z.enum(["cluster_summary", "evolution", "contradiction", "connection"])
```

#### `InsightStatusEnum`

```ts
import { InsightStatusEnum } from "@kore/shared-types";
// z.enum(["active", "evolving", "degraded", "retired", "failed"])
```

#### `InsightFrontmatterSchema` / `InsightFrontmatter`

Frontmatter schema for insight `.md` files in `$KORE_DATA_PATH/insights/`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Insight ID (e.g. `ins-a1b2c3d4`) |
| `type` | `"insight"` (literal) | Always `"insight"` |
| `category` | `string` | QMD URI inherited from cluster's dominant category |
| `date_saved` | `string` (ISO datetime) | When the insight was created |
| `source` | `"kore_synthesis"` (literal) | Always `"kore_synthesis"` |
| `tags` | `string[]` (max 5) | Tags from LLM synthesis |
| `insight_type` | `InsightType` | `cluster_summary`, `evolution`, `contradiction`, or `connection` |
| `source_ids` | `string[]` | IDs of source memories used in synthesis |
| `supersedes` | `string[]` | IDs of previous insights this replaces |
| `superseded_by` | `string[]` | IDs of newer insights that replace this one |
| `confidence` | `number` (0-1) | Computed confidence score |
| `status` | `InsightStatus` | Lifecycle status (default: `active`) |
| `reinforcement_count` | `number` | Times re-synthesized with new evidence (default: 0) |
| `re_eval_reason` | `"new_evidence" \| "source_deleted" \| null` | Why re-evaluation was triggered |
| `last_synthesized_at` | `string` (ISO datetime) | Last synthesis timestamp |

#### `InsightOutputSchema` / `InsightOutput`

Schema for LLM synthesis structured output:

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Insight title |
| `insight_type` | `InsightType` | LLM may override to `contradiction` |
| `synthesis` | `string` | 3-5 sentence synthesized summary |
| `connections` | `{ source_id, target_id, relationship }[]` | Structured relationships between sources |
| `distilled_items` | `string[]` (1-7) | Atomic synthesized facts |
| `tags` | `string[]` (1-5) | Kebab-case tags |

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
  InsightFrontmatterSchema,
  InsightOutputSchema,
  InsightTypeEnum,
  InsightStatusEnum,
} from "@kore/shared-types";
import type {
  BaseFrontmatter,
  MemoryExtraction,
  InsightFrontmatter,
  InsightOutput,
  KorePlugin,
} from "@kore/shared-types";
```

## Development

```sh
# Type check
bun run --filter @kore/shared-types typecheck

# Run tests
bun test packages/shared-types
```
