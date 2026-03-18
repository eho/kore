import { API_KEY, API_URL } from "./utils/env.ts";

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const MAX_RETRIES = 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { ok: false, status: res.status, message: text };
      }
      const data = (await res.json()) as T;
      return { ok: true, data };
    } catch (err: unknown) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        // Brief delay before retry for transient errors
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // All retries exhausted
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    ok: false,
    status: 0,
    message: `Cannot reach Kore API at ${API_URL} (${detail}). Is the server running?`,
  };
}
