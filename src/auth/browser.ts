import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { log } from "../log.ts";
import { findCode } from "./login.ts";

// Logging in without copying the code by hand: AH's login page ends by redirecting to the AH app's
// appie://login-exit?code=... link, which a browser can't open. A Chromium-based browser started with
// the DevTools protocol reports that redirect, so the code can be read from it.

/** How long the login window waits for the user. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long the browser gets to close before it is killed. */
const CLOSE_TIMEOUT_MS = 5000;
/** Temporary browser profiles are directories in the temp dir starting with this. */
const PROFILE_PREFIX = "albert-heijn-mcp-login-";
/** How long a new login window gets to fail before it counts as open. */
const START_CHECK_MS = 1500;
/** How long a failed login window is still worth mentioning. */
const ERROR_TTL_MS = 15 * 60_000;

/** Path of an installed Chromium-based browser (Chrome, Edge, Brave or Chromium) that can show a window. */
export function findBrowser(): string | undefined {
  return browserCandidates().find((path) => existsSync(path));
}

function browserCandidates(): string[] {
  switch (process.platform) {
    case "darwin": {
      // Over SSH there is no screen to show a window on.
      if (process.env.SSH_CONNECTION) return [];
      const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"];
      const dirs = ["/Applications", join(homedir(), "Applications")];
      return apps.flatMap((app) => dirs.map((dir) => join(dir, `${app}.app`, "Contents", "MacOS", app)));
    }
    case "win32": {
      if (process.env.SSH_CONNECTION) return [];
      const exes = [
        ["Google", "Chrome", "Application", "chrome.exe"],
        ["Microsoft", "Edge", "Application", "msedge.exe"],
        ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
        ["Chromium", "Application", "chrome.exe"],
      ];
      const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]];
      return exes.flatMap((exe) => roots.filter((root) => root !== undefined).map((root) => join(root, ...exe)));
    }
    default: {
      // Without a display (a server, an SSH session) a window can't be shown.
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return [];
      // Snap browsers (Ubuntu's Chromium, also behind /usr/bin/chromium-browser) have a private /tmp,
      // so their profile would land where it can't be removed.
      const snapChromium = existsSync("/snap/bin/chromium");
      const names = ["google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser"];
      if (!snapChromium) names.push("chromium", "chromium-browser");
      const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir && !dir.startsWith("/snap/"));
      return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
    }
  }
}

/** Opens url in the default browser; failures are ignored (the link is also returned). */
export function openInDefaultBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // Ignored.
  }
}

/** A login in a browser window that finishes in the background, e.g. while a tool call has returned. */
export class BrowserLogin {
  #window: { abort: AbortController; done: Promise<void> } | undefined;
  /** Set while the code from the window is being exchanged and saved. */
  #saving: Promise<void> | undefined;
  #failed: { error: Error; at: number } | undefined;

  /** Whether a login window is open and still waiting for the user. */
  get running(): boolean {
    return this.#window !== undefined && this.#saving === undefined;
  }

  /** Why the last login window didn't finish, if that was recent. */
  get error(): Error | undefined {
    return this.#failed && Date.now() - this.#failed.at < ERROR_TTL_MS ? this.#failed.error : undefined;
  }

  /** Waits while a code from the window is being saved, so the login is stored once this returns. */
  async saved(): Promise<void> {
    await this.#saving?.catch(() => {});
  }

  /** Closes the login window, if one is open, and waits until it has. */
  async cancel(): Promise<void> {
    this.#window?.abort.abort();
    await this.#window?.done;
  }

  /**
   * Opens a login window at url; onCode runs with the code once the user has logged in. Returns false
   * if no suitable browser is installed or the window failed right away (see error), e.g. no screen.
   */
  async start(url: string, onCode: (code: string) => Promise<void>): Promise<boolean> {
    this.#failed = undefined;
    const browser = findBrowser();
    if (!browser) return false;
    // One window at a time; a code the old one already has is saved (or reported) first.
    await this.saved();
    this.#window?.abort.abort();
    this.#saving = undefined;
    const abort = new AbortController();
    const fail = (err: unknown) => {
      // A cancel is on purpose (e.g. the login was finished another way), not a failure.
      if (abort.signal.aborted) return;
      log.warn("browser login failed", { err });
      this.#failed = { error: err instanceof Error ? err : new Error(String(err)), at: Date.now() };
    };
    // Saving failures are reported right away, not only once the window has closed.
    const save = (code: string) => (this.#saving = onCode(code).catch(fail));
    const window = {
      abort,
      done: loginInWindow(url, browser, save, abort.signal)
        .catch(fail)
        .finally(() => {
          // Only this window's state: a newer window may have started while this one closed.
          if (this.#window !== window) return;
          this.#window = undefined;
          this.#saving = undefined;
        }),
    };
    this.#window = window;
    // A browser that can't show a window usually exits at once.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([window.done, new Promise((resolve) => (timer = setTimeout(resolve, START_CHECK_MS)))]);
    clearTimeout(timer);
    return this.#window === window && this.#failed === undefined;
  }
}

/**
 * Opens url in a new window of browser, with a fresh profile; once the page redirects to the appie://
 * link, calls use with the login code and resolves with its result. The window closes afterwards, so
 * the short-lived code is used first. Rejects if the window is closed, times out or signal aborts first.
 * The browser is controlled over a pipe, not a network port, so no other program can attach to it.
 */
export async function loginInWindow<T>(
  url: string,
  browser: string,
  use: (code: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await removeOldProfiles();
  signal?.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  if (signal?.aborted) {
    await rm(profile, { recursive: true, force: true });
    signal.throwIfAborted();
  }
  let child: ChildProcess;
  try {
    child = spawn(
      browser,
      [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", url],
      // Its own process group, so Ctrl+C in a terminal reaches only this process, which then closes it.
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
  } catch (err) {
    await rm(profile, { recursive: true, force: true });
    throw err;
  }
  // "exit", not "close": a helper process may keep the pipes open after the browser has gone.
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const toBrowser = child.stdio[3] as Writable | null;
  const fromBrowser = child.stdio[4] as Readable | null;
  // No pipes if it couldn't start at all (e.g. too many open files).
  if (!toBrowser || !fromBrowser) {
    child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
    throw new Error("the browser could not be started");
  }
  // Errors also end the browser process, which ends the login.
  toBrowser.on("error", () => {});
  fromBrowser.on("error", () => {});
  let lastId = 0;
  /** Sends a command; returns its id. */
  const send = (method: string, params: object = {}, sessionId?: string): number => {
    toBrowser.write(`${JSON.stringify({ id: ++lastId, method, params, sessionId })}\0`);
    return lastId;
  };

  // The code counts only when AH's login site sends the tab there: a navigation of a tab's main frame
  // while it shows that site, or a redirect from it. Any other page could plant someone else's code.
  const mainFrames = new Map<string, { id: string; url: string }>();
  // On macOS the browser keeps running after its last window closes, so watch the tabs instead.
  const pages = new Set<string>();
  let onAllClosed = () => {};
  const frameTreeRequests = new Map<number, string>();
  const onMessage = (raw: string): string | undefined => {
    // Most messages are network events; parse only the few that can matter.
    if (!/appie:\/\/login-exit\?|"method":"(Target\.|Page\.frameNavigated)|"frameTree"/.test(raw)) return undefined;
    const msg = JSON.parse(raw) as CdpMessage;
    const p = msg.params ?? {};
    const sessionId = msg.sessionId ?? (msg.id !== undefined ? frameTreeRequests.get(msg.id) : undefined);
    const frame = p.frame ?? msg.result?.frameTree?.frame;
    if (frame && !frame.parentId && sessionId) mainFrames.set(sessionId, { id: frame.id, url: frame.url });
    switch (msg.method) {
      case "Target.targetCreated":
        if (p.targetInfo?.type === "page") {
          pages.add(p.targetInfo.targetId);
          send("Target.attachToTarget", { targetId: p.targetInfo.targetId, flatten: true });
        }
        break;
      case "Target.targetDestroyed":
        if (p.targetId && pages.delete(p.targetId) && pages.size === 0) onAllClosed();
        break;
      case "Target.attachedToTarget":
        if (p.sessionId) {
          send("Page.enable", {}, p.sessionId);
          // The page may have loaded before Page.enable, so ask which one it shows.
          frameTreeRequests.set(send("Page.getFrameTree", {}, p.sessionId), p.sessionId);
          // No response bodies are needed, so Chrome needn't keep them.
          send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, p.sessionId);
        }
        break;
      case "Page.frameRequestedNavigation":
      case "Page.frameScheduledNavigation": {
        const main = msg.sessionId ? mainFrames.get(msg.sessionId) : undefined;
        if (main && p.frameId === main.id && isAhPage(main.url)) return redirectCode(p.url);
        break;
      }
      case "Network.requestWillBeSent": {
        // Only the tab's own page: an embedded frame or image could be sent there through an ah.nl redirect.
        const main = msg.sessionId ? mainFrames.get(msg.sessionId) : undefined;
        if (p.type === "Document" && main && p.frameId === main.id && p.redirectResponse && isAhPage(p.redirectResponse.url)) {
          return redirectCode(p.request?.url);
        }
        break;
      }
    }
    return undefined;
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the login window timed out")), LOGIN_TIMEOUT_MS);
      const closed = () => reject(new Error("the login window was closed before the login finished"));
      void exited.then(closed);
      onAllClosed = closed;
      const cancelled = () => reject(new Error("the login was cancelled"));
      if (signal?.aborted) cancelled();
      signal?.addEventListener("abort", cancelled, { once: true });
      child.once("error", reject);
      readMessages(fromBrowser, (raw) => {
        try {
          const code = onMessage(raw);
          if (code) resolve(code);
        } catch {
          // Not a message we can use.
        }
      });
      // Also reports the tabs that are already open.
      send("Target.setDiscoverTargets", { discover: true });
    });
    return await use(code);
  } finally {
    clearTimeout(timer);
    fromBrowser.removeAllListeners("data");
    // Not if it failed to start or has already exited.
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      send("Browser.close");
      const killTimer = setTimeout(() => killBrowser(child), CLOSE_TIMEOUT_MS);
      await exited;
      clearTimeout(killTimer);
    }
    // A helper process may still hold the pipes; they'd keep this process running.
    toBrowser.destroy();
    fromBrowser.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

/** Kills the browser and, where it has its own process group, its helper processes too. */
function killBrowser(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Removes temporary profiles left behind by a process that was killed during a login: they may hold
 * AH cookies. Only ones older than any login window can be, so a window open elsewhere is left alone.
 */
async function removeOldProfiles(): Promise<void> {
  // Twice the timeout: saving the code can still take a while after the window got it.
  const cutoff = Date.now() - 2 * LOGIN_TIMEOUT_MS;
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.startsWith(PROFILE_PREFIX))) {
    const path = join(tmpdir(), name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    } catch {
      // E.g. another user's, or already gone; the others still get removed.
    }
  }
}

/** Calls onMessage with each message from the browser: JSON text, each ending in a NUL byte. */
function readMessages(stream: Readable, onMessage: (raw: string) => void): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    let start = 0;
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0", start)) {
      onMessage(buffered.slice(start, end));
      start = end + 1;
    }
    buffered = buffered.slice(start);
  });
}

/** The login code if url is the appie://login-exit link itself, not merely mentions it. */
function redirectCode(url: string | undefined): string | undefined {
  return url?.startsWith("appie://login-exit?") ? findCode(url) : undefined;
}

/** Reports whether url is a page of AH's login site, which sends the browser to the appie:// link. */
function isAhPage(url: string): boolean {
  try {
    return new URL(url).hostname === "login.ah.nl";
  } catch {
    return false;
  }
}

/** The parts of DevTools protocol messages used here. */
interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: {
    sessionId?: string;
    targetInfo?: { targetId: string; type: string };
    frame?: CdpFrame;
    frameId?: string;
    targetId?: string;
    type?: string;
    url?: string;
    request?: { url: string };
    redirectResponse?: { url: string };
  };
  result?: { frameTree?: { frame: CdpFrame } };
}

interface CdpFrame {
  id: string;
  parentId?: string;
  url: string;
}
