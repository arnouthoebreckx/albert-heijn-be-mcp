import { createWriteStream, type WriteStream } from "node:fs";

// Logs go to stderr; stdout carries the stdio transport. Errors are logged
// without AH's response text, which may hold customer data.

type Level = "INFO" | "WARN" | "ERROR";

let file: WriteStream | undefined;

/** Also appends logs to the file at path. */
export function logToFile(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    stream.once("open", () => {
      file = stream;
      resolve();
    });
    stream.once("error", reject);
  });
}

/** An error that can describe itself without data from outside, e.g. AH's response text. */
export interface LogSafe {
  logText(): string;
}

/**
 * err as safe log text: our own messages and AH's status codes, never AH's
 * response text or other data from outside, which may hold customer data.
 */
export function describeError(err: unknown): string {
  if (typeof (err as Partial<LogSafe> | null)?.logText === "function") return (err as LogSafe).logText();
  if (!(err instanceof Error)) return `non-error value (${typeof err})`;
  // Plain errors are ours; others (e.g. a JSON parse error) may quote what they failed on.
  if (err.constructor === Error) return err.message;
  const code = errorCode(err) ?? errorCode(err.cause);
  return code ? `${err.name} ${code}` : err.name;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function format(value: unknown): string {
  const s = String(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

function write(level: Level, msg: string, attrs: Record<string, unknown>): void {
  const parts = [`time=${new Date().toISOString()}`, `level=${level}`, `msg=${format(msg)}`];
  for (const [key, value] of Object.entries(attrs)) {
    // Errors, and whatever was thrown under err, are described safely.
    const safe = value instanceof Error || key === "err" ? describeError(value) : value;
    if (value !== undefined) parts.push(`${key}=${format(safe)}`);
  }
  const line = `${parts.join(" ")}\n`;
  process.stderr.write(line);
  file?.write(line);
}

let closing: Promise<void> | undefined;

/** Flushes and closes the log file, waiting at most 1 s; call before exiting. Every call waits for the same flush. */
export function closeLog(): Promise<void> {
  closing ??= new Promise((resolve) => {
    const f = file;
    file = undefined;
    if (!f) return resolve();
    const timer = setTimeout(resolve, 1000);
    f.end(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return closing;
}

export const log = {
  info: (msg: string, attrs: Record<string, unknown> = {}) => write("INFO", msg, attrs),
  warn: (msg: string, attrs: Record<string, unknown> = {}) => write("WARN", msg, attrs),
  error: (msg: string, attrs: Record<string, unknown> = {}) => write("ERROR", msg, attrs),
};
