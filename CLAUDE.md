---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
alwaysApply: true
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Documentation Structure

When creating or organizing project documentation, use this folder structure under `docs/`:

- `docs/vision/` — strategic vision, design principles, product goals
- `docs/architecture/` — system architecture, data schemas, technology decisions
- `docs/design/` — feature-level design specs (one doc per feature)
- `docs/planning/` — assessments, roadmap, and ongoing planning docs
- `docs/testing/` — QA guides, testing strategies, manual test walkthroughs

Keep a `docs/README.md` as an index linking to key documents across all sections.
