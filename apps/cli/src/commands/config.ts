import { API_KEY, API_URL, maskApiKey, resolvedEnvPath } from "../utils/env.ts";

export async function configCommand(opts: { json: boolean }): Promise<void> {
  const envPath = await resolvedEnvPath();
  const maskedKey = maskApiKey(API_KEY);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          KORE_API_URL: API_URL,
          KORE_API_KEY_SET: Boolean(API_KEY),
          KORE_API_KEY_MASKED: maskedKey,
          env_file: envPath,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  process.stdout.write(
    [
      `KORE_API_URL:  ${API_URL}`,
      `KORE_API_KEY:  ${maskedKey}`,
      `Env file:      ${envPath ?? "(none found)"}`,
    ].join("\n") + "\n"
  );
}
