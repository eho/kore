import { join } from "node:path";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { format } from "node:util";
import { resolveKoreHome } from "./config";

let stream: WriteStream | null = null;

function timestamp(): string {
  return new Date().toISOString();
}

function sessionLogPath(): string {
  const logsDir = join(resolveKoreHome(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(logsDir, `kore-${ts}.log`);
}

function makeWriter(original: (...args: unknown[]) => void, level: string) {
  return (...args: unknown[]) => {
    const msg = format(...args);
    const line = `[${timestamp()}] [${level}] ${msg}`;
    // Use original method for terminal output so Bun's color coding is preserved
    original(line);
    stream?.write(line + "\n");
  };
}

export function initLogger(): void {
  const logFile = sessionLogPath();
  stream = createWriteStream(logFile, { flags: "a" });

  console.log = makeWriter(console.log.bind(console), "INFO");
  console.info = makeWriter(console.info.bind(console), "INFO");
  console.warn = makeWriter(console.warn.bind(console), "WARN");
  console.error = makeWriter(console.error.bind(console), "ERROR");

  // Use the patched console.log so this line also goes to the log file
  console.log(`Logging to ${logFile}`);
}

export function closeLogger(): void {
  stream?.end();
  stream = null;
}
