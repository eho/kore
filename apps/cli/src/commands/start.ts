import { resolve } from "node:path";

export async function startCommand(): Promise<void> {
  const serverPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "core-api",
    "src",
    "index.ts"
  );

  const proc = Bun.spawn(["bun", "run", serverPath], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
