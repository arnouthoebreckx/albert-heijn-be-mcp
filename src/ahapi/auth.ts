import { site } from "../site.ts";
import type { AhClient } from "./client.ts";

/** AH login page of the site. After login it redirects to appie://login-exit?code=... (see exchangeCode). */
export function loginUrl(): string {
  const { loginBase, clientId } = site();
  return `${loginBase}/login?client_id=${clientId}&response_type=code&redirect_uri=appie://login-exit`;
}

/** Response of the token endpoints. */
export interface Token {
  access_token: string;
  refresh_token: string;
  /** Access token lifetime in seconds. */
  expires_in?: number;
}

/** Gets a token for a visitor without an account (see AnonymousSession). */
export function anonymousToken(c: AhClient): Promise<Token> {
  return c.request<Token>("/mobile-auth/v1/auth/token/anonymous", {
    method: "POST",
    body: { clientId: site().clientId },
  });
}

/** Exchanges an OAuth authorization code for tokens. */
export function exchangeCode(c: AhClient, code: string): Promise<Token> {
  return c.request<Token>("/mobile-auth/v1/auth/token", {
    method: "POST",
    body: { clientId: site().clientId, code },
  });
}

/** Exchanges a refresh token for a new pair. The old refresh token stops working (AH rotates them). */
export function refreshToken(c: AhClient, refreshToken: string): Promise<Token> {
  return c.request<Token>("/mobile-auth/v1/auth/token/refresh", {
    method: "POST",
    body: { clientId: site().clientId, refreshToken },
  });
}
