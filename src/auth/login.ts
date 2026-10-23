import { LOGIN_URL } from "../ahapi/index.ts";

/** code=... in the pasted appie://login-exit link or the console line quoting it; links elsewhere don't count. */
const CODE_PARAM = /appie:\/\/login-exit\?(?:[^\s'"]*&)?code=([A-Za-z0-9._~-]+)/;
/** A bare code. */
const BARE_CODE = /^[A-Za-z0-9._~-]{8,}$/;

/** The login code in an appie://login-exit link anywhere in text, if there is one. */
export function findCode(text: string): string | undefined {
  return CODE_PARAM.exec(text)?.[1];
}

/** Extracts the login code from the pasted redirect link, console line, or bare code. */
export function extractCode(input: string): string {
  const trimmed = input.trim();
  const code = findCode(trimmed);
  if (code) return code;
  if (BARE_CODE.test(trimmed)) return trimmed;
  throw new Error("no login code found: paste the appie://login-exit?code=... link or the code itself");
}

/** Said before a login when AH no longer accepts the stored one. */
export const STALE_LOGIN = "The stored Albert Heijn login no longer works, so log in to Albert Heijn again.";

/** The steps for logging in by copying the code by hand; paste says where the last step pastes the link. */
export function manualLoginSteps(opened: boolean, paste: string): string {
  return `1. Open this link in Chrome, Edge or Brave${opened ? " (it may have opened in your default browser; use that tab only if it's one of these)" : ""}, but don't log in yet:
   ${LOGIN_URL}
2. On that page, open the developer console first: Cmd+Option+J on Mac, Ctrl+Shift+J on Windows/Linux.
   It's a panel for web developers and safe to open. If you already logged in, open the link again in that same tab.
3. Log in. The page then seems stuck: AH tries to open its phone app, which the browser can't.
   In the console, find the red line "Failed to launch 'appie://login-exit?code=...'" and copy
   the link from appie:// up to the closing quote. Other browsers may show the link in an error page instead.
4. Paste that link ${paste}. It works once and expires quickly, so do this right away.`;
}
