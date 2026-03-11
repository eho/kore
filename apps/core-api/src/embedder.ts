import { embed } from "@kore/qmd-client";

const DEFAULT_INTERVAL_MS = 600_000; // 10 minutes

export interface EmbedderDeps {
  intervalMs?: number;
  embedFn?: typeof embed;
}

export interface EmbedderHandle {
  stop: () => void;
}

/**
 * Start a periodic interval that calls `qmdClient.embed()` to generate
 * vector embeddings for documents that need them.
 *
 * If `embed()` fires while another operation is running, the concurrency
 * lock in qmd-client will serialize the calls automatically.
 *
 * Errors are logged but never crash the interval.
 */
export function startEmbedInterval(deps?: EmbedderDeps): EmbedderHandle {
  const intervalMs = deps?.intervalMs
    ?? (process.env.KORE_EMBED_INTERVAL_MS
      ? Number(process.env.KORE_EMBED_INTERVAL_MS)
      : DEFAULT_INTERVAL_MS);
  const embedFn = deps?.embedFn ?? embed;

  const handle = setInterval(async () => {
    try {
      const result = await embedFn();
      console.log(
        `Embedder: embed complete (docs: ${result.docsProcessed}, chunks: ${result.chunksEmbedded})`,
      );
    } catch (err) {
      console.error("Embedder: embed error (non-fatal):", err);
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
