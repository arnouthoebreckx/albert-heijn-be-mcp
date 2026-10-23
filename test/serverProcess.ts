import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./helpers.ts";

/** An empty home, and none of the machine's AH_* settings, so no tokens file or .env is read. */
export function cleanEnv(extra: Record<string, string> = {}): { env: Record<string, string>; home: string } {
  const home = mkdtempSync(join(tmpdir(), "ah-be-mcp-"));
  const env: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, PATH: process.env.PATH ?? "" };
  return { env: { ...env, ...extra }, home };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface RunningServer {
  child: ChildProcess;
  /** What the process wrote to stderr so far. */
  stderr(): string;
  stop(): Promise<void>;
}

/** Starts the server (src/index.ts) as a process with these arguments. */
export function startServer(args: string[], extraEnv: Record<string, string>): RunningServer {
  const { env, home } = cleanEnv(extraEnv);
  const child = spawn(process.execPath, [`${root}src/index.ts`, ...args], { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return {
    child,
    stderr: () => stderr,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** GET with node's http, which unlike fetch lets a test set the Host header. */
export function get(host: string, port: number, path: string, hostHeader?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = hostHeader ? { Host: hostHeader } : {};
    request({ host, port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

/** Polls until `path` (default /healthz) answers 200 (or `ready` says so), or throws after `ms`, or as soon as `alive` says the server died. */
export async function waitUntilUp(
  port: number,
  { host = "127.0.0.1", hostHeader, alive = () => true, ms = 30_000, path = "/healthz", ready = (status) => status === 200 }: { host?: string; hostHeader?: string; alive?: () => boolean; ms?: number; path?: string; ready?: (status: number) => boolean } = {},
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (ready((await get(host, port, path, hostHeader)).status)) return;
    } catch {
      // not listening yet
    }
    if (!alive()) throw new Error(`the server exited before ${host}:${port}${path} answered`);
    if (Date.now() > deadline) throw new Error(`${host}:${port}${path} was not ready within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
