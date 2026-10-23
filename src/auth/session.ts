import { rm } from "node:fs/promises";
import { AhClient, ContextError, exchangeCode, fullName, getMember, hasStatus, isUnauthorized, type Member, refreshToken, wrapError } from "../ahapi/index.ts";
import type { LogSafe } from "../log.ts";
import { DamagedTokensError, loadTokens, saveTokens, type TokenFile, toTokenFile, withFileLock } from "./tokens.ts";

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

/** No tokens are stored. */
export class NotLoggedInError extends Error implements LogSafe {
  constructor() {
    super("not logged in");
    this.name = "NotLoggedInError";
  }

  logText(): string {
    return this.message;
  }
}

/** AH rejected the stored refresh token (expired or revoked): the user must log in again. */
export class SessionExpiredError extends ContextError {
  constructor(cause: unknown) {
    super("token refresh failed: the Albert Heijn login expired or was revoked; log in to Albert Heijn again", cause);
    this.name = "SessionExpiredError";
  }
}

/**
 * The stored login: none, stale (AH no longer accepts it), or ok with the member. If AH couldn't be
 * asked, the login may still work, so it counts as ok, with the error instead of the member.
 * refreshToken is the one that was checked, to pass to completeLogin as ifStillStored.
 */
export type LoginStatus = { refreshToken?: string } & (
  | { state: "none" }
  | { state: "stale" }
  | { state: "ok"; member?: Member; error?: Error }
);

function expiresSoon(tf: TokenFile): boolean {
  // No refresh if AH sent no lifetime: NaN compares false.
  return Date.parse(tf.expires_at ?? "") - Date.now() < REFRESH_MARGIN_MS;
}

/**
 * Login session: stored tokens and API clients built from them.
 *
 * Token writes are serialised, within this process and across all processes
 * sharing the tokens file: refresh tokens rotate, so parallel refreshes would
 * race, and a pending refresh must not undo a logout or login.
 * Tokens are re-read on every call to pick up refreshes by other processes.
 */
export class Session {
  readonly tokensPath: string;
  #lock: Promise<unknown> = Promise.resolve();
  /** The refresh token this process's last token refresh saved, to tell refreshes from new logins. */
  #refreshed: string | undefined;

  constructor(tokensPath: string) {
    this.tokensPath = tokensPath;
  }

  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(this.tokensPath, fn);
    const run = this.#lock.then(locked, locked);
    this.#lock = run.catch(() => {});
    return run;
  }

  /** Returns an authenticated client, refreshing the token first if it expires soon. */
  async client(): Promise<AhClient> {
    // Lock only to refresh: another process may have refreshed meanwhile, so re-check.
    const tf = await this.#requireTokens();
    if (!expiresSoon(tf)) return new AhClient(tf.access_token);
    return this.#withLock(async () => {
      let fresh = await this.#requireTokens();
      if (expiresSoon(fresh)) fresh = await this.#refresh(fresh);
      return new AhClient(fresh.access_token);
    });
  }

  /** Runs fn with an authenticated client; on a 401, refreshes the token and runs it once more. */
  async withClient<T>(fn: (c: AhClient) => Promise<T>): Promise<T> {
    const c = await this.client();
    try {
      return await fn(c);
    } catch (err) {
      if (!isUnauthorized(err) || !c.token) throw err;
      return fn(await this.refreshAfterRejection(c.token));
    }
  }

  /** The logged-in member. */
  member(): Promise<Member> {
    return this.withClient(getMember);
  }

  /** Checks the stored login with AH (see LoginStatus). */
  loginStatus(): Promise<LoginStatus> {
    return this.#loginStatus(true);
  }

  async #loginStatus(retry: boolean): Promise<LoginStatus> {
    // Also none for a corrupt tokens file: a new login replaces it.
    const before = await this.storedRefreshToken();
    if (!before) return { state: "none" };
    let status: LoginStatus;
    try {
      status = { state: "ok", member: await this.member() };
    } catch (err) {
      if (err instanceof NotLoggedInError) return { state: "none" };
      const error = err instanceof Error ? err : new Error(String(err));
      status = err instanceof SessionExpiredError ? { state: "stale" } : { state: "ok", error };
    }
    // Checking may have refreshed the tokens (fine), or a login was saved or removed meanwhile: then
    // check again, so the status describes the refresh token it returns.
    const after = await this.storedRefreshToken();
    if (after !== before && after !== this.#refreshed) {
      if (retry) return this.#loginStatus(false);
      if (!after) return { state: "none" };
      // Still changing: count it as working, so a new login doesn't replace it.
      return { state: "ok", refreshToken: after, error: new Error("the login changed while it was being checked") };
    }
    return { ...status, refreshToken: after };
  }

  /** The member's name, or "" if it can't be fetched. */
  async memberName(): Promise<string> {
    try {
      return fullName(await this.member());
    } catch {
      return "";
    }
  }

  /**
   * The stored refresh token; undefined if there is none, or the tokens file is damaged or not ours to
   * read: no use to this process, so a new login replaces it. Other read errors (e.g. too many open
   * files) are thrown: the login may still be there and work.
   */
  async storedRefreshToken(): Promise<string | undefined> {
    try {
      return (await loadTokens(this.tokensPath))?.refresh_token || undefined;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (err instanceof DamagedTokensError || code === "EACCES" || code === "EPERM") return undefined;
      throw err;
    }
  }

  /** After AH rejected staleAccessToken: refreshes (unless already replaced) and returns a new client. */
  refreshAfterRejection(staleAccessToken: string): Promise<AhClient> {
    return this.#withLock(async () => {
      let tf = await this.#requireTokens();
      if (tf.access_token === staleAccessToken) tf = await this.#refresh(tf);
      return new AhClient(tf.access_token);
    });
  }

  async #requireTokens(): Promise<TokenFile> {
    const tf = await loadTokens(this.tokensPath);
    if (!tf?.refresh_token) throw new NotLoggedInError();
    return tf;
  }

  async #refresh(tf: TokenFile): Promise<TokenFile> {
    let tok;
    try {
      tok = await refreshToken(new AhClient(), tf.refresh_token);
    } catch (err) {
      // 400/401 mean the refresh token is no good; anything else may be temporary.
      throw hasStatus(err, 400) || hasStatus(err, 401) ? new SessionExpiredError(err) : wrapError("token refresh failed", err);
    }
    const next = toTokenFile(tok);
    await saveTokens(this.tokensPath, next);
    this.#refreshed = next.refresh_token;
    return next;
  }

  /**
   * Exchanges a login code for tokens and saves them; returns whether it did. Not if another login was
   * saved since ifStillStored (from loginStatus) was read: a working login is never replaced.
   */
  completeLogin(code: string, ifStillStored: string | undefined): Promise<boolean> {
    return this.#withLock(async () => {
      const now = await this.storedRefreshToken();
      if (now !== undefined && now !== ifStillStored) return false;
      let tok;
      try {
        tok = await exchangeCode(new AhClient(), code);
      } catch (err) {
        throw wrapError("exchange code (codes are single-use and expire quickly; log in again for a new one)", err);
      }
      await saveTokens(this.tokensPath, toTokenFile(tok));
      return true;
    });
  }

  /** Deletes the tokens file, even if corrupt. Returns whether it existed. */
  logout(): Promise<boolean> {
    return this.#withLock(async () => {
      try {
        await rm(this.tokensPath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw wrapError("remove tokens", err);
      }
    });
  }
}
