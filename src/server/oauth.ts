import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout } from "node:timers/promises";
import { log } from "../log.ts";
import { isLoopbackHost, readBody, sameSecret, sha256 } from "./request.ts";

// OAuth 2.1 for clients that connect over HTTP, e.g. ChatGPT and Claude.ai: the
// server is its own authorization server, and the owner logs in with AH_MCP_TOKEN.
//
// Nothing is stored. Client IDs, login codes and tokens are signed with a key
// derived from AH_MCP_TOKEN, so they survive restarts and changing the token
// revokes them all. Login codes are single-use within this process.
//
// MCP requests need an access token: AH_MCP_TOKEN itself is only for logging in,
// so it never travels with every request or in a URL.

const CODE_TTL = 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
/** Refreshing renews tokens until this long after the login; then the client logs in again. */
const MAX_LOGIN_AGE = 90 * 24 * 60 * 60;
const MAX_FORM_BYTES = 64 * 1024;
/**
 * Delay before answering a wrong token. It slows guessing without locking anyone
 * out: a lockout would let anyone who can reach the server block the owner's login.
 */
const FAILED_LOGIN_DELAY_MS = 1000;

type Kind = "client" | "code" | "access" | "refresh";

interface ClientClaims {
  redirectUris: string[];
  name?: string | undefined;
}

interface CodeClaims {
  client: string;
  redirectUri: string;
  challenge: string;
  jti: string;
  exp: number;
}

interface TokenClaims {
  client: string;
  exp: number;
}

interface RefreshClaims extends TokenClaims {
  /** When the owner logged in; absent in refresh tokens from before 1.5.0. */
  auth?: number;
}

class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;

  constructor(code: string, description: string, status = 400) {
    super(`${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const clientHash = (clientId: string) => b64url(sha256(clientId)).slice(0, 22);

/** The OAuth routes (handle) and the check for MCP requests (authenticate). */
export class OAuth {
  readonly #key: Buffer;
  readonly #secretHash: Buffer;
  readonly #issuer: string;
  readonly #issuerOrigin: string;
  readonly #resource: string;
  readonly #resourceMetadataPath: string;
  readonly #challenge: string;
  /** JSON bodies of the two metadata documents, which never change. */
  readonly #resourceMetadata: string;
  readonly #serverMetadata: string;
  readonly #usedCodes = new Map<string, number>();

  /** baseUrl is the public URL of the server; MCP is served at mcpPath under it. secret is AH_MCP_TOKEN. */
  constructor(baseUrl: string, mcpPath: string, secret: string) {
    this.#issuer = baseUrl.replace(/\/+$/, "");
    this.#issuerOrigin = new URL(this.#issuer).origin;
    this.#resource = this.#issuer + mcpPath;
    this.#secretHash = sha256(secret);
    this.#key = createHmac("sha256", secret).update("albert-heijn-mcp oauth v1").digest();
    this.#resourceMetadataPath = `/.well-known/oauth-protected-resource${new URL(this.#resource).pathname}`;
    this.#challenge = `Bearer resource_metadata="${this.#issuer}${this.#resourceMetadataPath}"`;
    this.#resourceMetadata = JSON.stringify({
      resource: this.#resource,
      authorization_servers: [this.#issuer],
      bearer_methods_supported: ["header"],
    });
    this.#serverMetadata = JSON.stringify({
      issuer: this.#issuer,
      authorization_endpoint: `${this.#issuer}/authorize`,
      token_endpoint: `${this.#issuer}/token`,
      registration_endpoint: `${this.#issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  }

  /**
   * Checks an MCP request for an unexpired access token as "Authorization: Bearer …".
   * Returns the WWW-Authenticate header for a 401, or undefined if allowed.
   */
  authenticate(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    if (bearer === undefined) return this.#challenge;
    if (this.#verify<TokenClaims>("access", bearer)) return undefined;
    return `${this.#challenge}, error="invalid_token"`;
  }

  /** Serves the OAuth routes; returns false for other paths. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = this.#route(url.pathname);
    if (!route) return false;
    // Browser-based clients call these from another origin; none use cookies.
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
          "Access-Control-Max-Age": "86400",
        })
        .end();
      return true;
    }
    if (!route.methods.includes(req.method ?? "")) {
      res.writeHead(405, { Allow: route.methods.join(", ") }).end("Method Not Allowed");
      return true;
    }
    try {
      await route.serve(req, res, url);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      sendJson(res, err.status, { error: err.code, error_description: err.description });
    }
    return true;
  }

  #route(path: string): { methods: string[]; serve: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void } | undefined {
    switch (path) {
      case "/.well-known/oauth-protected-resource":
      case this.#resourceMetadataPath:
        return { methods: ["GET"], serve: (_req, res) => sendJson(res, 200, this.#resourceMetadata) };
      case "/.well-known/oauth-authorization-server":
        return { methods: ["GET"], serve: (_req, res) => sendJson(res, 200, this.#serverMetadata) };
      case "/register":
        return { methods: ["POST"], serve: (req, res) => this.#register(req, res) };
      case "/authorize":
        return { methods: ["GET", "POST"], serve: (req, res, url) => this.#authorize(req, res, url) };
      case "/token":
        return { methods: ["POST"], serve: (req, res) => this.#tokenEndpoint(req, res) };
      default:
        return undefined;
    }
  }

  /** Dynamic client registration (RFC 7591): the client ID is the signed registration. */
  async #register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let meta: { redirect_uris?: unknown; client_name?: unknown };
    try {
      meta = (JSON.parse(await readOAuthBody(req)) ?? {}) as typeof meta;
    } catch (err) {
      if (err instanceof OAuthError) throw err;
      throw new OAuthError("invalid_client_metadata", "the body must be JSON");
    }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
    }
    if (!uris.every((uri) => typeof uri === "string" && isAllowedRedirect(uri))) {
      throw new OAuthError("invalid_redirect_uri", "redirect URIs must be https, http on localhost, or an app scheme");
    }
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;
    sendJson(res, 201, {
      client_id: this.#sign("client", { redirectUris: uris, name } satisfies ClientClaims),
      client_id_issued_at: now(),
      redirect_uris: uris,
      client_name: name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  /** GET shows the login page; POST checks the password and redirects back with a code. */
  async #authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const params = req.method === "POST" ? new URLSearchParams(await readOAuthBody(req)) : url.searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const client = this.#verify<ClientClaims>("client", clientId);
    // Bad requests get an error page rather than a redirect: anyone can register a client, so
    // redirecting before the owner has acted would make this server an open redirector.
    const challenge = params.get("code_challenge") ?? "";
    if (
      !client ||
      !client.redirectUris.includes(redirectUri) ||
      // The form posts from this server's own page; a post from another site must not lead to a redirect either.
      (req.method === "POST" && !this.#isOwnOrigin(req.headers.origin)) ||
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      !this.#isOurResource(params.get("resource"))
    ) {
      sendPage(res, 400, errorPage("This login link is not valid. Start connecting again from your app."));
      return;
    }
    const back = (query: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [k, v] of Object.entries({ ...query, iss: this.#issuer })) url.searchParams.set(k, v);
      const state = params.get("state");
      if (state) url.searchParams.set("state", state);
      res.writeHead(302, { Location: url.href, "Cache-Control": "no-store" }).end();
    };

    const showLogin = (status: number, error?: string) =>
      sendPage(res, status, loginPage(this.#issuer, params, client, redirectUri, error));
    if (req.method !== "POST") return showLogin(200);
    if (params.get("action") === "deny") return back({ error: "access_denied" });
    if (!sameSecret(params.get("password") ?? "", this.#secretHash)) {
      await setTimeout(FAILED_LOGIN_DELAY_MS);
      log.warn("OAuth login failed", { client: client.name ?? "unnamed" });
      return showLogin(401, "That's not the right token.");
    }
    const code: CodeClaims = {
      client: clientHash(clientId),
      redirectUri,
      challenge,
      jti: b64url(randomBytes(12)),
      exp: now() + CODE_TTL,
    };
    log.info("OAuth login", { client: client.name ?? "unnamed" });
    back({ code: this.#sign("code", code) });
  }

  async #tokenEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readOAuthBody(req));
    const clientId = params.get("client_id") ?? "";
    if (!this.#verify<ClientClaims>("client", clientId)) throw new OAuthError("invalid_client", "unknown client", 401);
    if (!this.#isOurResource(params.get("resource"))) throw new OAuthError("invalid_target", "unknown resource");
    const client = clientHash(clientId);
    const t = now();
    let auth = t;

    switch (params.get("grant_type")) {
      case "authorization_code": {
        const code = this.#verify<CodeClaims>("code", params.get("code") ?? "");
        if (!code || code.client !== client || code.redirectUri !== params.get("redirect_uri")) {
          throw new OAuthError("invalid_grant", "the code is invalid or expired");
        }
        const verifier = params.get("code_verifier") ?? "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(sha256(verifier)) !== code.challenge) {
          throw new OAuthError("invalid_grant", "the code verifier does not match");
        }
        if (!this.#useCode(code)) throw new OAuthError("invalid_grant", "the code was already used");
        break;
      }
      case "refresh_token": {
        const refresh = this.#verify<RefreshClaims>("refresh", params.get("refresh_token") ?? "");
        if (!refresh || refresh.client !== client) throw new OAuthError("invalid_grant", "the refresh token is invalid or expired");
        auth = refresh.auth ?? t;
        if (t - auth >= MAX_LOGIN_AGE) throw new OAuthError("invalid_grant", "the login is too old; log in again");
        break;
      }
      default:
        throw new OAuthError("unsupported_grant_type", "use authorization_code or refresh_token");
    }
    sendJson(res, 200, {
      access_token: this.#sign("access", { client, exp: t + ACCESS_TTL } satisfies TokenClaims),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: this.#sign("refresh", {
        client,
        exp: Math.min(t + REFRESH_TTL, auth + MAX_LOGIN_AGE),
        auth,
      } satisfies RefreshClaims),
    });
  }

  /** Browsers send Origin with form posts; it is absent only from non-browser clients, which can't be tricked. */
  #isOwnOrigin(origin: string | undefined): boolean {
    return origin === undefined || origin === this.#issuerOrigin;
  }

  /** Clients may name the MCP endpoint or the server as the resource (RFC 8707), or omit it. */
  #isOurResource(resource: string | null): boolean {
    if (!resource) return true;
    return [this.#resource, this.#issuer].includes(resource.replace(/\/+$/, ""));
  }

  #useCode(code: CodeClaims): boolean {
    const t = now();
    for (const [jti, exp] of this.#usedCodes) if (exp < t) this.#usedCodes.delete(jti);
    if (this.#usedCodes.has(code.jti)) return false;
    this.#usedCodes.set(code.jti, code.exp);
    return true;
  }

  /** kind.payload.signature; the kind is signed too, so one kind can't pass for another. */
  #sign(kind: Kind, claims: object): string {
    const payload = b64url(JSON.stringify(claims));
    return `${payload}.${this.#mac(kind, payload)}`;
  }

  #verify<T extends object>(kind: Kind, value: string): T | undefined {
    const [payload, mac, extra] = value.split(".");
    if (!payload || !mac || extra !== undefined) return undefined;
    const expected = Buffer.from(this.#mac(kind, payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T & { exp?: number };
      if (claims.exp !== undefined && claims.exp < now()) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }

  #mac(kind: Kind, payload: string): string {
    return createHmac("sha256", this.#key).update(`${kind}.${payload}`).digest("base64url");
  }
}

/** https anywhere, http only on loopback, or an app's own scheme (e.g. cursor://); never script or data URLs. */
function isAllowedRedirect(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"].includes(url.protocol);
}

async function readOAuthBody(req: IncomingMessage): Promise<string> {
  try {
    return await readBody(req, MAX_FORM_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === "request body too large") throw new OAuthError("invalid_request", err.message, 413);
    throw err;
  }
}

/** body is an object to serialise, or JSON already serialised. */
function sendJson(res: ServerResponse, status: number, body: object | string): void {
  res
    .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    .end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  res
    .writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // No scripts, no framing (clickjacking), and the login link stays out of Referer headers sent
      // to other sites. Not "no-referrer": it would make the form's own posts send Origin: null.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    })
    .end(html);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Request parameters carried through the login form. */
const FORWARDED = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

function loginPage(issuer: string, params: URLSearchParams, client: ClientClaims, redirectUri: string, error?: string): string {
  const hidden = FORWARDED.flatMap((k) => {
    const v = params.get(k);
    return v === null ? [] : [`<input type="hidden" name="${k}" value="${escapeHtml(v)}">`];
  }).join("");
  // The name is whatever the app registered with, so it's labelled as such; the destination
  // shows the scheme too, since x-app://claude.ai is not claude.ai.
  const app = client.name ? `An app calling itself <strong>${escapeHtml(client.name)}</strong>` : "An app";
  const { protocol, host } = new URL(redirectUri);
  const target = escapeHtml(host ? `${protocol}//${host}` : protocol);
  return page(
    "Connect to Albert Heijn",
    `<h1>Connect to Albert Heijn</h1>
<p>${app} wants to use this albert-heijn-mcp server, with access to your Albert Heijn account. You'll be sent back to <strong>${target}</strong>.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(issuer)}/authorize">${hidden}
<label for="password">Server token (AH_MCP_TOKEN)</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<div class="actions"><button type="submit" name="action" value="allow">Connect</button>
<button type="submit" name="action" value="deny" class="secondary" formnovalidate>Cancel</button></div>
</form>`,
  );
}

function errorPage(message: string): string {
  return page("Can't connect", `<h1>Can't connect</h1><p>${escapeHtml(message)}</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--fg:#1a1a1a;--muted:#5b6470;--accent:#00ade6;--border:#d6dbe0;--err:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c1f24;--fg:#eceff1;--muted:#9aa3ad;--border:#343a42;--err:#ef6c6c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{box-sizing:border-box;width:min(420px,100% - 32px);background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:1.3rem;margin:0 0 12px}p{color:var(--muted);margin:0 0 16px}strong{color:var(--fg)}
label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit}
.actions{display:flex;gap:8px;margin-top:16px}
button{flex:1;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--border)}
.error{color:var(--err);font-weight:600}
</style></head><body><main>${body}</main></body></html>`;
}
