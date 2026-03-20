import { resolve } from "node:path";

export async function mcpCommand(): Promise<void> {
  // Resolve the mcp-server entry point relative to the CLI package
  const mcpServerPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "mcp-server",
    "index.ts"
  );

  // Spawn the stdio proxy, inheriting stdio so the MCP client can communicate
  const proc = Bun.spawn(["bun", "run", mcpServerPath], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  });

  // Forward exit code
  const exitCode = await proc.exited;
  process.exit(exitCode);
}
