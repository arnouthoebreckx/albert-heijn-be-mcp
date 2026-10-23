import { AhClient, anonymousToken, isUnauthorized } from "../ahapi/index.ts";

/** Renew this long before the access token expires. */
const RENEW_MARGIN_MS = 60_000;

interface AnonymousToken {
  access: string;
  expiresAt: number;
}

/**
 * Anonymous mode: AH's token for a visitor without an account. It is fetched at the first call and
 * kept in memory only; no tokens file is read or written. Same shape as Session for the tools that
 * need no login.
 */
export class AnonymousSession {
  #token: Promise<AnonymousToken> | undefined;

  /** Returns a client with a valid token, getting a new one first if there is none or it expires soon. */
  async client(): Promise<AhClient> {
    const seen = this.#token;
    if (!seen) return new AhClient((await this.#renew()).access);
    let token = await seen;
    if (token.expiresAt - Date.now() < RENEW_MARGIN_MS) {
      // Renew, unless a parallel call already did while this one waited.
      token = await (this.#token && this.#token !== seen ? this.#token : this.#renew());
    }
    return new AhClient(token.access);
  }

  /** Runs fn with a client; on a 401, renews the token and runs it once more. A second 401 is an error. */
  async withClient<T>(fn: (c: AhClient) => Promise<T>): Promise<T> {
    const c = await this.client();
    try {
      return await fn(c);
    } catch (err) {
      if (!isUnauthorized(err) || !c.token) throw err;
      return fn(await this.#renewAfterRejection(c.token));
    }
  }

  /** After AH rejected stale: renews, unless a parallel call already did. */
  async #renewAfterRejection(stale: string): Promise<AhClient> {
    const current = await this.#token?.catch(() => undefined);
    const token = current && current.access !== stale ? current : await this.#renew();
    return new AhClient(token.access);
  }

  #renew(): Promise<AnonymousToken> {
    const token = anonymousToken(new AhClient()).then((t) => ({
      access: t.access_token,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : Infinity,
    }));
    this.#token = token;
    // A failed request isn't kept: the next call asks again.
    token.catch(() => {
      if (this.#token === token) this.#token = undefined;
    });
    return token;
  }
}
