# `@kore/qmd-client`

Typed wrapper around the [QMD](https://github.com/tobilu/qmd) CLI. All interactions with QMD go through this package — nothing in `apps/` calls `qmd` directly via shell.

## Prerequisites

QMD must be installed and available on `$PATH`:

```sh
# Verify QMD is accessible
qmd status
```

## API

All functions return typed result objects instead of throwing on failure. Check `success` / `online` before using the result.

---

### `update() → Promise<QmdCommandResult>`

Triggers `qmd update` to refresh the index after new `.md` files are written.

```ts
import { update } from "@kore/qmd-client";

const result = await update();
// Wraps: qmd update

if (!result.success) {
  console.error("QMD update failed:", result.error);
}
```

---

### `collectionAdd(path, name) → Promise<QmdCommandResult>`

Registers a directory as a QMD collection.

```ts
import { collectionAdd } from "@kore/qmd-client";

const result = await collectionAdd("/Users/you/kore-data", "kore-memory");
// Wraps: qmd collection add /Users/you/kore-data --name kore-memory
```

---

### `status() → Promise<QmdStatusResult>`

Checks if QMD is responsive. Used by the health endpoint.

```ts
import { status } from "@kore/qmd-client";

const result = await status();
// Wraps: qmd status

if (result.online) {
  console.log("QMD is up");
} else {
  console.warn("QMD unavailable:", result.error);
}
```

---

## Return Types

```ts
interface QmdCommandResult {
  success: boolean;
  error?: string;  // populated when success is false
}

interface QmdStatusResult {
  online: boolean;
  error?: string;  // populated when online is false
}
```

## Error Handling

- If the `qmd` binary is not found, the spawn fails gracefully and returns `{ success: false, error: "Failed to spawn \"qmd\": ..." }`.
- If `qmd` exits with a non-zero code, `stderr` is captured and returned in `error`.
- No unhandled exceptions are thrown to callers.

## Development

```sh
# Type check
bun run --filter @kore/qmd-client typecheck

# Run tests (mocks Bun.spawn — no QMD binary required)
bun test packages/qmd-client
```
