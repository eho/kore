import { randomUUID } from "crypto";
import { join } from "node:path";
import { QueueRepository } from "./queue";
import { EventDispatcher } from "./event-dispatcher";
import { extract } from "@kore/llm-extractor";
import { MemoryExtractionSchema } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";
import { slugify } from "./slugify";
import { renderMarkdown } from "./markdown";

const TYPE_DIRS: Record<string, string> = {
  place: "places",
  media: "media",
  note: "notes",
  person: "people",
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

export interface WorkerDeps {
  queue: QueueRepository;
  dataPath: string;
  dispatcher?: EventDispatcher;
  extractFn?: typeof extract;
  pollIntervalMs?: number;
}

/**
 * Resolve a collision-safe file path for a memory file.
 * If the target already exists, appends a 4-char UUID hash suffix.
 */
async function resolveFilePath(
  dataPath: string,
  type: string,
  title: string
): Promise<string> {
  const dir = join(dataPath, TYPE_DIRS[type] || "notes");
  const slug = slugify(title);
  let filePath = join(dir, `${slug}.md`);

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const hash = randomUUID().replace(/-/g, "").slice(0, 4);
    filePath = join(dir, `${slug}_${hash}.md`);
  }

  return filePath;
}

interface ProcessTaskResult {
  id: string;
  filePath: string;
  frontmatter: BaseFrontmatter;
}

/**
 * Process a single task: extract structured data via LLM, write the
 * canonical Markdown file to disk, and update the queue status.
 */
async function processTask(
  taskId: string,
  payload: { source: string; content: string; original_url?: string },
  deps: WorkerDeps
): Promise<ProcessTaskResult> {
  const extractFn = deps.extractFn || extract;

  // Call the LLM extractor
  const raw = await extractFn(payload.content, payload.source);

  // Validate against MemoryExtractionSchema
  const parsed = MemoryExtractionSchema.parse(raw);

  // Build frontmatter
  const id = randomUUID();
  const frontmatter: BaseFrontmatter = {
    id,
    type: parsed.type,
    category: parsed.qmd_category,
    date_saved: new Date().toISOString(),
    source: payload.source,
    tags: parsed.tags,
    ...(payload.original_url ? { url: payload.original_url } : {}),
  };

  // Resolve file path with collision handling
  const filePath = await resolveFilePath(deps.dataPath, parsed.type, parsed.title);

  // Render canonical Markdown template
  const md = renderMarkdown({
    frontmatter,
    title: parsed.title,
    distilledItems: parsed.distilled_items,
    rawSource: payload.content,
  });

  // Write to disk
  await Bun.write(filePath, md);

  // Mark completed
  deps.queue.markCompleted(taskId);

  return { id, filePath, frontmatter };
}

/**
 * Run a single poll cycle: dequeue one task and process it.
 * Returns true if a task was processed, false if the queue was empty.
 */
export async function pollOnce(deps: WorkerDeps): Promise<boolean> {
  const task = deps.queue.dequeueAndLock();
  if (!task) return false;

  try {
    const payload = JSON.parse(task.payload);
    console.log(`Worker: processing task ${task.id} (source: ${payload.source}, attempt ${task.retries + 1})`);
    const result = await processTask(task.id, payload, deps);
    console.log(`Worker: task ${task.id} completed`);

    // Emit memory.indexed event after successful extraction
    if (deps.dispatcher) {
      await deps.dispatcher.emit("memory.indexed", {
        id: result.id,
        filePath: result.filePath,
        frontmatter: result.frontmatter,
        timestamp: new Date().toISOString(),
        taskId: task.id,
      });
    }

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Worker: task ${task.id} failed (attempt ${task.retries + 1}): ${message}`);
    deps.queue.markFailed(task.id, message);
    return true;
  }
}

/**
 * Start the background extraction worker loop.
 * Polls the queue at a configurable interval, processes tasks,
 * and periodically cleans up old completed/failed tasks.
 */
export function startWorker(deps: WorkerDeps): { stop: () => void } {
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Recover any stale tasks on startup
  const recovered = deps.queue.recoverStaleTasks();
  if (recovered > 0) {
    console.log(`Worker: recovered ${recovered} stale task(s)`);
  }

  // Poll loop
  const pollTimer = setInterval(async () => {
    try {
      await pollOnce(deps);
    } catch (err) {
      console.error("Worker poll error:", err);
    }
  }, intervalMs);

  // Periodic cleanup (every hour)
  const cleanupTimer = setInterval(() => {
    try {
      const removed = deps.queue.cleanupOldTasks(7);
      if (removed > 0) {
        console.log(`Worker: cleaned up ${removed} old task(s)`);
      }
    } catch (err) {
      console.error("Worker cleanup error:", err);
    }
  }, CLEANUP_INTERVAL_MS);

  return {
    stop() {
      clearInterval(pollTimer);
      clearInterval(cleanupTimer);
    },
  };
}
