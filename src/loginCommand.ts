import { createInterface } from "node:readline/promises";
import { fullName, LOGIN_URL } from "./ahapi/index.ts";
import { findBrowser, loginInWindow, openInDefaultBrowser } from "./auth/browser.ts";
import { extractCode, manualLoginSteps, STALE_LOGIN } from "./auth/login.ts";
import type { Session } from "./auth/session.ts";

/**
 * `albert-heijn-mcp login`: logs in from the terminal and saves the tokens, e.g. to copy them to a
 * server afterwards. Uses a login window when a Chromium-based browser is installed, unless remote;
 * otherwise asks for the code from the appie:// link.
 */
export async function runLogin(session: Session, remote: boolean): Promise<void> {
  const status = await session.loginStatus();
  if (status.state === "ok") {
    const who = status.member ? ` as ${fullName(status.member)}` : ` (could not check it with AH: ${status.error?.message})`;
    console.log(`Already logged in${who}. To switch accounts, delete ${session.tokensPath} first.`);
    return;
  }
  if (status.state === "stale") console.log(STALE_LOGIN);

  // A login saved meanwhile, e.g. by an MCP client, is kept.
  const save = (code: string) => session.completeLogin(code, status.refreshToken);
  const saved = (remote ? undefined : await windowLogin(save)) ?? (await save(await manualCode(!remote)));
  if (!saved) {
    console.log(`Someone logged in meanwhile; kept that login. To switch accounts, delete ${session.tokensPath} first.`);
    return;
  }
  const name = await session.memberName();
  console.log(`Logged in${name ? ` as ${name}` : ""}. Tokens saved to ${session.tokensPath}`);
}

/** Logs in with a login window and returns what save returned, or undefined if no window could be used. */
async function windowLogin(save: (code: string) => Promise<boolean>): Promise<boolean | undefined> {
  const browser = findBrowser();
  if (!browser) return undefined;
  console.log("A browser window with the Albert Heijn login page is opening. Log in there; it closes by itself.");
  // Ctrl+C or a closed terminal closes the window and removes its profile before exiting.
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);
  let saveFailed = false;
  const trackedSave = (code: string) =>
    save(code).catch((err: unknown) => {
      saveFailed = true;
      throw err;
    });
  try {
    return await loginInWindow(LOGIN_URL, browser, trackedSave, abort.signal);
  } catch (err) {
    // The window did its part if saving failed; logging in by hand wouldn't help.
    if (abort.signal.aborted || saveFailed) throw err;
    console.log(`The login window didn't work (${(err as Error).message}), so log in by hand instead.\n`);
    return undefined;
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
  }
}

/** The code the user pastes after logging in by hand; open opens the login page in the default browser. */
async function manualCode(open: boolean): Promise<string> {
  if (open) openInDefaultBrowser(LOGIN_URL);
  console.log(`${manualLoginSteps(open, "below")}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return extractCode(await rl.question("Link: "));
  } finally {
    rl.close();
  }
}
