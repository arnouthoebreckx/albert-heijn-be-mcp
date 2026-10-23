import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fullName, getMember, LOGIN_URL } from "../ahapi/index.ts";
import { openInDefaultBrowser } from "../auth/browser.ts";
import { extractCode, manualLoginSteps, STALE_LOGIN } from "../auth/login.ts";
import { log } from "../log.ts";
import { addAuthedTool, addTool, structured, text, type ToolContext } from "./common.ts";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    {
      name: "ah_login",
      title: "Albert Heijn: Log In",
      kind: "additive",
      description:
        "Log in to Albert Heijn. Call without arguments to start. " +
        "On the user's own computer this usually opens a login window that finishes the login by itself. " +
        "Otherwise it returns the AH login link and step-by-step instructions: show them to the user as given, " +
        "in order (the developer console must be open before they log in). The user then copies a link like " +
        "appie://login-exit?code=...; call ah_login again with code set to that link (or just the code) to finish. " +
        "Codes are single-use and expire quickly. " +
        "If already logged in, returns the account name; to switch accounts, call ah_logout first.",
      input: {
        code: z
          .string()
          .optional()
          .describe(
            "The appie://login-exit?code=... link the user copied after logging in, or just the code. Omit to start a login.",
          ),
      },
    },
    async ({ code }) => {
      // A working session is never replaced, not even with a code: one planted in a web page or
      // document would otherwise switch the user to someone else's account without them noticing.
      // A stored session that AH no longer accepts (e.g. a revoked refresh token) gets a new login.
      const switchHint = code ? " To switch accounts, call ah_logout first, then ah_login." : "";
      // The user may have just logged in there: let the window finish saving the login first.
      await ctx.browserLogin.saved();
      const status = await ctx.session.loginStatus();
      if (status.state === "ok") {
        void ctx.browserLogin.cancel();
        return text(
          status.member
            ? `Already connected as ${fullName(status.member)}.${switchHint}`
            : `Already logged in (could not fetch member name: ${status.error?.message}).${switchHint}`,
        );
      }
      if (code) {
        // This login replaces the window's either way.
        void ctx.browserLogin.cancel();
        if (!(await ctx.session.completeLogin(extractCode(code), status.refreshToken))) {
          // E.g. the login window saved one just before; either way, a working login is kept.
          const name = await ctx.session.memberName();
          return text(`${name ? `Already connected as ${name}` : "Already logged in"}; that login is kept.${switchHint}`);
        }
        const name = await ctx.session.memberName();
        return text(name ? `Login successful! Connected as ${name}.` : "Login successful!");
      }
      const intro = status.state === "stale" ? `${STALE_LOGIN}\n\n` : "";
      if (ctx.remote) return text(intro + manualLogin(false, ctx.hosted));
      if (ctx.browserLogin.running) {
        return text(
          `${intro}The login window is still open: ask the user to finish logging in there, then call ah_login again.\n\n` +
            `If they can't find the window, they can log in this way instead.\n\n${manualLogin(false)}`,
        );
      }
      const failed = ctx.browserLogin.error;
      // A login saved meanwhile, e.g. with a pasted code, is kept.
      const opened = await ctx.browserLogin.start(LOGIN_URL, async (windowCode) => {
        if (!(await ctx.session.completeLogin(windowCode, status.refreshToken))) {
          throw new Error("another login was saved meanwhile, so this one wasn't used");
        }
        log.info("browser login finished");
      });
      if (opened) {
        const why = failed ? `The last login window didn't finish (${failed.message}). ` : "";
        const opening =
          `${intro}${why}A login window with the Albert Heijn login page has opened. ` +
          "Ask the user to log in there; it closes by itself. When they're done, call ah_login again to confirm.";
        // After a failure the window may never appear (e.g. no screen), so also give the manual way.
        return text(failed ? `${opening}\n\nIf no window appears, they can log in this way instead.\n\n${manualLogin(false)}` : opening);
      }
      // start() reports only a failure of the window it just tried.
      const broken = ctx.browserLogin.error;
      const why = broken ? `The login window couldn't open (${broken.message}). ` : "";
      openInDefaultBrowser(LOGIN_URL);
      return text(intro + why + manualLogin(true));
    },
  );

  addTool(
    server,
    {
      name: "ah_logout",
      title: "Albert Heijn: Log Out",
      kind: "destructive",
      description:
        "Log out of Albert Heijn by deleting the stored tokens. " +
        "Use this to switch accounts or reset a broken session. " +
        "After logout, call ah_login to authenticate again.",
    },
    async () => {
      // A login window could otherwise log the user back in afterwards.
      await ctx.browserLogin.cancel();
      return (await ctx.session.logout())
        ? text("Logged out. Call ah_login to authenticate again.")
        : text("Already logged out (no active session).");
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_member_profile",
      title: "Albert Heijn: Member Profile",
      kind: "readOnly",
      output: { name: z.string(), email: z.string().optional(), bonus_card_number: z.string().optional() },
      description:
        "Get your Albert Heijn member profile. " +
        "Returns name, email (masked), and bonus_card_number (last 4 digits only).",
    },
    async (c) => {
      const m = await getMember(c);
      const card = m.bonusCardNumber;
      return structured({
        name: fullName(m),
        email: maskEmail(m.email) || undefined,
        bonus_card_number: card ? (card.length > 4 ? `****${card.slice(-4)}` : card) : undefined,
      });
    },
  );
}

/** "jan.jansen@gmail.com" → "jan…@gmail.com": enough to recognise the account. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email ? "…" : "";
  return `${email.slice(0, Math.min(3, at - 1))}…${email.slice(at)}`;
}

/** Hosted logins are often started from a phone app, whose browser has no developer console. */
const HOSTED_LOGIN_NOTE =
  "This needs a computer: phone browsers have no developer console.\n\n";

/** For whoever runs the server: the login command needs no developer console. */
const SERVER_LOGIN_HINT =
  "\n\nWhoever runs this server can instead log it in without the console, from their own computer: " +
  "see https://github.com/olekpuchka/albert-heijn-mcp#running-it-on-a-server";

/** Steps for logging in by copying the code by hand; hosted adds what matters when the server runs elsewhere. */
function manualLogin(opened: boolean, hosted = false): string {
  const steps = manualLoginSteps(opened, "here");
  return `To log in to Albert Heijn:\n\n${hosted ? HOSTED_LOGIN_NOTE + steps + SERVER_LOGIN_HINT : steps}`;
}
