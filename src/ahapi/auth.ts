import { type AhClient, CLIENT_NAME } from "./client.ts";

/** AH login page. After login it redirects to appie://login-exit?code=... (see exchangeCode). */
export const LOGIN_URL = `https://login.ah.nl/login?client_id=${CLIENT_NAME}&response_type=code&redirect_uri=appie://login-exit`;

/** Response of the token endpoints. */
export interface Token {
  access_token: string;
  refresh_token: string;
  /** Access token lifetime in seconds. */
  expires_in?: number;
}

/** Exchanges an OAuth authorization code for tokens. */
export function exchangeCode(c: AhClient, code: string): Promise<Token> {
  return c.request<Token>("/mobile-auth/v1/auth/token", {
    method: "POST",
    body: { clientId: CLIENT_NAME, code },
  });
}

/** Exchanges a refresh token for a new pair. The old refresh token stops working (AH rotates them). */
export function refreshToken(c: AhClient, refreshToken: string): Promise<Token> {
  return c.request<Token>("/mobile-auth/v1/auth/token/refresh", {
    method: "POST",
    body: { clientId: CLIENT_NAME, refreshToken },
  });
}
