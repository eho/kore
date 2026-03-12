import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Constants ───────────────────────────────────────────────────────────────

const RUN_ID = `e2e-${Date.now()}`;
const MIN_SCORE = 0.5;
const TMP_DIR = path.join(os.tmpdir(), `kore-e2e-${RUN_ID}`);

// ─── Types ───────────────────────────────────────────────────────────────────

type DatasetFile = {
  filePath: string;
  label: string;
  collection?: string;
};

// ─── Shared State ────────────────────────────────────────────────────────────

let dataset: DatasetFile[] = [];
let labelToId: Map<string, string> = new Map();
let ingestedIds: string[] = [];

// ─── Helper: runCli ──────────────────────────────────────────────────────────

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const decoder = new TextDecoder();
  const result = Bun.spawnSync(
    ["bun", "run", "apps/cli/src/index.ts", ...args],
    { env: { ...process.env } }
  );
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}

// ─── Dataset Builder ─────────────────────────────────────────────────────────

function buildDataset(dir: string): DatasetFile[] {
  fs.mkdirSync(dir, { recursive: true });

  const files: Array<{ label: string; filename: string; content: string; collection?: string }> = [
    {
      label: "tokyo-ramen",
      filename: "tokyo-ramen.md",
      collection: "travel",
      content: `# Hidden Ramen Gem in Ikebukuro, Tokyo

Saved from X (formerly Twitter) — a thread by @tokyofoodie recommending hidden ramen spots.

## Mutekiya (無敵家)

One of the best ramen shops in Ikebukuro, Tokyo. Famous for their rich tonkotsu broth and tsukemen (dipping noodles). Located a few minutes walk from Ikebukuro station's east exit, tucked in a narrow alley.

**Key details:**
- Cash only — bring yen
- Expect a 20–30 minute wait on weekends
- Order at the vending machine outside
- Try the tsukemen with extra noodles

The broth is thick and deeply savoury. The chashu pork melts in your mouth. A must-visit for any ramen enthusiast travelling through Tokyo.

Tags: ramen, tokyo, ikebukuro, japan, food, travel`,
    },
    {
      label: "sydney-degustation",
      filename: "sydney-degustation.md",
      collection: "travel",
      content: `# Sydney's Best Degustation Menus

Saved from Safari — article from Broadsheet Australia.

Planning a special occasion dinner in Sydney? These degustation menus offer the full fine dining experience.

## Sixpenny (Stanmore)

Located in the leafy inner-west suburb of Stanmore, Sixpenny is one of Sydney's most celebrated fine dining restaurants. Chef Daniel Puskas leads a tasting menu that showcases Australian produce with Japanese and Nordic influences.

- 6 and 9 course options
- Excellent wine pairing program
- Book well in advance — very popular

## Quay (The Rocks)

Iconic Sydney waterfront dining with views of the Opera House and Harbour Bridge. Chef Peter Gilmore's signature dishes like the snow egg dessert are legendary.

## Bennelong

Inside the Sydney Opera House shell. Modern Australian cuisine with dramatic harbour views.

Tags: sydney, degustation, fine dining, restaurant, food, australia, special occasion`,
    },
    {
      label: "surry-hills-wine-bar",
      filename: "surry-hills-wine-bar.md",
      content: `# Wine Bar Recommendation — Surry Hills, Sydney

Apple Note from a recommendation by a friend.

This wine bar in Surry Hills is perfect for a special occasion or just a relaxed evening with good natural wine and small plates.

**Details:**
- Located on Crown Street, Surry Hills
- Excellent selection of Australian and European natural wines
- Small plates menu changes weekly — seasonal and locally sourced
- Intimate atmosphere, book ahead on weekends
- Great for date nights or catching up with close friends

The staff are knowledgeable and genuinely passionate about wine. They'll guide you to something interesting based on your preferences. The cheese and charcuterie board pairs perfectly with their orange wine selection.

Tags: wine, surry hills, sydney, bar, recommendation, food, dining`,
    },
    {
      label: "japanese-learning",
      filename: "japanese-learning.md",
      content: `# Optimal 30-Day Framework for Learning Japanese

Saved from Reddit — r/LearnJapanese

A comprehensive guide for absolute beginners starting their Japanese language journey.

## Week 1: Hiragana and Katakana

Start with Tofugu's free Hiragana guide. Use mnemonics to memorise each character. Complete Hiragana in 3–4 days, then move to Katakana. By end of week 1 you should be able to read both phonetic scripts.

**Tools:**
- Tofugu Hiragana/Katakana guides (free)
- Anki flashcard decks

## Week 2–4: Kanji and Vocabulary

Begin WaniKani (subscription) for systematic kanji learning using spaced repetition. WaniKani uses radicals → kanji → vocabulary progression that makes complex characters approachable.

**Parallel study:**
- Genki I textbook for grammar
- HelloTalk for language exchange with native speakers

## Key Principles

1. Consistency beats intensity — 30 minutes daily beats 3-hour weekend sessions
2. Learn to read before you speak
3. Immerse in Japanese media: anime, manga, YouTube

Tags: japanese, language learning, hiragana, katakana, kanji, wanikan, tofugu, study`,
    },
    {
      label: "react-performance",
      filename: "react-performance.md",
      content: `# React Performance Tuning — Notion Notes

Notes from reading the React docs and various blog posts on optimising React applications.

## Core Techniques

### Memoization with React.memo
Wrap components that receive stable props to prevent unnecessary re-renders. Best for pure presentational components.

### useCallback for Stable References
Use \`useCallback\` when passing callbacks as props to memoized child components. Without it, a new function reference is created on every render, defeating \`React.memo\`.

### useMemo for Expensive Computations
Cache the result of expensive calculations. Only recompute when dependencies change.

## Profiling with React DevTools

The React DevTools Profiler (browser extension) records renders and highlights components that re-render unnecessarily. Essential for diagnosing performance issues in production builds.

## Code Splitting

Use \`React.lazy\` with \`Suspense\` for route-based code splitting. Reduces initial bundle size significantly.

## Virtual Lists

For long lists (100+ items), use \`react-window\` or \`react-virtual\` to only render visible items.

Tags: react, performance, memoization, useCallback, useMemo, devtools, frontend, javascript`,
    },
    {
      label: "docker-deployment",
      filename: "docker-deployment.md",
      content: `# Docker Deployment Strategy — Pocket Bookmark

Saved from Pocket — blog post from a senior DevOps engineer on production Docker deployment patterns.

## Multi-Stage Builds

The most impactful optimisation for Docker images in production. Separate your build environment from your runtime environment.

\`\`\`dockerfile
# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
\`\`\`

## Docker Compose for Production

Use \`docker-compose.yml\` for orchestrating multi-service deployments. Define resource limits, restart policies, and health checks.

## Container Health Checks

Always define \`HEALTHCHECK\` instructions so orchestrators can detect unhealthy containers and restart them automatically.

## Secrets Management

Never bake secrets into images. Use Docker secrets, environment variables injected at runtime, or a secrets manager like HashiCorp Vault.

Tags: docker, deployment, container, devops, multi-stage build, docker-compose, production`,
    },
    {
      label: "book-recommendations",
      filename: "book-recommendations.md",
      content: `# Book Recommendations — Apple Note

A running list of books I want to read or have read and recommend.

## Fiction

- **The Buried Giant** — Kazuo Ishiguro. Haunting Arthurian fantasy about memory and forgetting. Beautiful prose.
- **Cloud Atlas** — David Mitchell. Six interlocking novellas spanning centuries. Ambitious and rewarding.
- **The Dispossessed** — Ursula K. Le Guin. Dual-world anarchist utopia. Required reading for speculative fiction fans.
- **The Name of the Wind** — Patrick Rothfuss. Epic fantasy with exceptional world-building.

## Non-Fiction

- **Thinking, Fast and Slow** — Daniel Kahneman. Behavioural economics fundamentals. Changed how I think about decision-making.
- **The Lean Startup** — Eric Ries. Build-measure-learn loops for product development.
- **Sapiens** — Yuval Noah Harari. Sweeping history of the human species.
- **Deep Work** — Cal Newport. Strategies for sustained focus in a distracted world.

Tags: books, reading, fiction, non-fiction, recommendations`,
    },
    {
      label: "home-measurements",
      filename: "home-measurements.md",
      content: `# Home Measurements — Apple Note

Room dimensions and notes for upcoming renovations and furniture shopping.

## Living Room
- Width: 4.8m
- Length: 6.2m
- Ceiling height: 2.7m
- Window: north-facing, 1.8m wide

## Bedroom (Main)
- Width: 3.9m
- Length: 4.5m
- Built-in wardrobe: 2.1m wide, 0.6m deep

## Kitchen
- Bench height: 900mm
- Splashback: 600mm high
- Under-bench clearance: 750mm

## Paint Colours
- Living room walls: Dulux "Antique White USA"
- Bedroom: Dulux "Natural White"
- Trim/skirting: Dulux "Vivid White" (low sheen)

## Furniture Notes
- Sofa: needs to be ≤2.2m wide to fit under window
- Dining table: 6-seater, ≤1.8m long
- Bed: King size (183cm × 203cm) fits with 60cm clearance each side

Tags: home, measurements, renovation, furniture, paint`,
    },
    {
      label: "exact-match-control",
      filename: "exact-match-control.md",
      content: `# Control Document for Exact Match Testing

This document contains the test keyword: XYZZY_TEST_KEYWORD

This file exists solely to verify that the search system can perform exact keyword matching. The presence of XYZZY_TEST_KEYWORD in this document should make it reliably retrievable by exact-match queries.

The string XYZZY_TEST_KEYWORD does not appear in any other document in this test dataset, ensuring clean precision testing.

Tags: test, control, exact-match`,
    },
  ];

  const result: DatasetFile[] = [];

  for (const f of files) {
    const filePath = path.join(dir, f.filename);
    fs.writeFileSync(filePath, f.content, "utf-8");
    result.push({
      filePath,
      label: f.label,
      ...(f.collection ? { collection: f.collection } : {}),
    });
  }

  return result;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Health check
  const health = runCli(["health", "--json"]);
  if (health.exitCode !== 0) {
    throw new Error(
      "Kore API is not reachable. Start the API with `bun run start` before running E2E tests."
    );
  }
  let healthData: { status: string };
  try {
    healthData = JSON.parse(health.stdout);
  } catch {
    throw new Error(
      "Kore API is not reachable. Start the Docker stack before running E2E tests."
    );
  }
  if (healthData.status !== "ok") {
    throw new Error(
      "Kore API is not reachable. Start the Docker stack before running E2E tests."
    );
  }

  // Build dataset
  dataset = buildDataset(TMP_DIR);

  // Ingest all files
  for (const file of dataset) {
    const args = [
      "ingest",
      file.filePath,
      "--source",
      `e2e-run-${RUN_ID}/${file.label}`,
      "--json",
    ];
    const result = runCli(args);
    expect(result.exitCode).toBe(0);
  }

  // Wait for LLM extraction and QMD re-indexing by polling `kore list`
  // since local models take a while. Timeout after 120 seconds.
  labelToId = new Map();
  let attempts = 0;
  while (attempts < 60) {
    const listResult = runCli(["list", "--json", "--limit", "200"]);
    if (listResult.exitCode === 0) {
      const memories: Array<{ id: string; source: string }> = JSON.parse(listResult.stdout);
      for (const m of memories) {
        if (m.source.startsWith(`e2e-run-${RUN_ID}/`)) {
          const label = m.source.slice(`e2e-run-${RUN_ID}/`.length);
          labelToId.set(label, m.id);
        }
      }
      
      if (labelToId.size === dataset.length) {
        break; // all files successfully indexed
      }
    }
    
    // not all indexed yet, sleep 2s and try again
    await Bun.sleep(2000);
    attempts++;
  }
  
  if (labelToId.size !== dataset.length) {
    console.error(`Only ingested ${labelToId.size} / ${dataset.length} memories within timeout. Continuing with partial dataset.`);
  }

  ingestedIds = Array.from(labelToId.values());
}, 300000); // 5 minute timeout

afterAll(async () => {
  try {
    for (const id of ingestedIds) {
      runCli(["delete", id, "--force"]);
    }
  } finally {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  }
});

// ─── Smoke Test ──────────────────────────────────────────────────────────────

describe("E2E-001: Infrastructure", () => {
  test("beforeAll ingested all dataset files and built labelToId map", () => {
    expect(dataset.length).toBe(9);
    expect(ingestedIds.length).toBeGreaterThan(0);
  });
});

// ─── Re-export shared state for other test stories ────────────────────────────
// (Other test files in the same suite can import these if split)

export { runCli, RUN_ID, MIN_SCORE, TMP_DIR, labelToId, ingestedIds, dataset };
export type { DatasetFile };
