import type { OperationDeps, RememberInput, RememberOutput } from "./types";

export async function remember(
  params: RememberInput,
  deps: Pick<OperationDeps, "queue">
): Promise<RememberOutput> {
  const taskId = deps.queue.enqueue(
    {
      source: params.source ?? "agent",
      content: params.content,
      original_url: params.url,
      suggested_tags: params.suggested_tags,
      suggested_category: params.suggested_category,
    },
    params.priority ?? "normal"
  );

  return {
    task_id: taskId,
    status: "queued",
    message: "Memory queued for extraction. It will be searchable once processing completes.",
  };
}
