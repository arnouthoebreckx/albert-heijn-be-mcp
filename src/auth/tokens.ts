import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Token } from "../ahapi/index.ts";

export interface TokenFile {
  access_token: string;
  refresh_token: string;
  /** ISO 8601; absent if AH sent no lifetime. */
  expires_at?: string;
}

/** <user config dir>/albert-heijn-mcp/tokens.json, per OS convention. */
export function defaultTokensPath(): string {
  let configDir: string;
  if (process.platform === "darwin") {
    configDir = join(homedir(), "Library", "Application Support");
  } else if (process.platform === "win32") {
    configDir = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  } else {
    configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  }
  return join(configDir, "albert-heijn-mcp", "tokens.json");
}

/** Token response → file format. */
export function toTokenFile(t: Token): TokenFile {
  const tf: TokenFile = { access_token: t.access_token, refresh_token: t.refresh_token };
  if (t.expires_in) tf.expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  return tf;
}

/** The tokens file isn't valid JSON with both tokens. */
export class DamagedTokensError extends Error {
  constructor(path: string) {
    super(`the tokens file ${path} is damaged; log in again`);
    this.name = "DamagedTokensError";
  }
}

/** Returns undefined if the file does not exist. */
export async function loadTokens(path: string): Promise<TokenFile | undefined> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let tf: Partial<TokenFile> | undefined;
  try {
    tf = JSON.parse(data) as Partial<TokenFile>;
  } catch {
    // Not reported as is: the parse error would quote the file, i.e. the tokens.
  }
  if (typeof tf?.access_token !== "string" || typeof tf.refresh_token !== "string") {
    throw new DamagedTokensError(path);
  }
  return tf as TokenFile;
}

/** Writes atomically with mode 0600. */
export async function saveTokens(path: string, tf: TokenFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A new, random name: "wx" refuses an existing file or symlink, which someone else could have placed there.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(tf, null, 2), { flag: "wx", mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** A lock older than this is from a crashed process (a refresh request times out after 30 s). */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 70_000;

/**
 * Runs fn holding an exclusive lock on the tokens file, shared by all albert-heijn-mcp
 * processes using it. Refresh tokens rotate, so two processes must not refresh at once.
 * The lock file holds a random ID that identifies its owner (inode numbers get reused).
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, id, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await removeIfStale(lock)) continue;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    // Delete the lock only if it is still ours (not taken over as stale).
    if ((await readLockId(lock)) === id) await rm(lock, { force: true });
  }
}

/** The lock's owner ID; undefined if the lock is gone, null if it can't be read. */
async function readLockId(lock: string): Promise<string | undefined | null> {
  try {
    return await readFile(lock, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/**
 * Removes lock if it is stale; returns true if the caller should retry at once.
 * The lock is first renamed aside, which only one process can do for a given
 * file. If the file moved is a fresh lock that replaced the stale one in the
 * meantime (a different owner ID), it is put back.
 */
async function removeIfStale(lock: string): Promise<boolean> {
  // Read the ID before checking the age: a lock that replaced the stale one is
  // fresh, so its ID is never taken for the stale one's.
  const staleId = await readLockId(lock);
  if (staleId === undefined) return true;
  // Unreadable (e.g. left by another user): treat as held, so the caller waits and times out.
  if (staleId === null) return false;
  const seen = await stat(lock).catch(() => undefined);
  if (!seen) return true;
  if (Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return false;
  const aside = `${lock}.${process.pid}.${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if ((await readLockId(aside)) !== staleId) await link(aside, lock).catch(() => {});
  await rm(aside, { force: true });
  return true;
}
