import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { AhApiError, searchProducts } from "../src/ahapi/index.ts";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { defaultTokensPath } from "../src/auth/tokens.ts";
import { loadConfig } from "../src/config.ts";
import { configureSite } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

const TOKEN_PATH = "/mobile-auth/v1/auth/token/anonymous";
const search = (session: AnonymousSession) => session.withClient((c) => searchProducts(c, "kipfilet", 5));

// Done-when 4 (spec section 4).
test("--anonymous and AH_ANONYMOUS=true turn anonymous mode on", () => {
  assert.equal(loadConfig([], {}).anonymous, false);
  assert.equal(loadConfig(["--anonymous"], {}).anonymous, true);
  assert.equal(loadConfig([], { AH_ANONYMOUS: "true" }).anonymous, true);
  assert.equal(loadConfig([], { AH_ANONYMOUS: "false" }).anonymous, false);
});

for (const [site, clientId] of [["be", "appie-be-ios"], ["nl", "appie-ios"]] as const) {
  test(`the first call gets an anonymous token for the ${site} clientId, once`, async () => {
    configureSite(site);
    const calls = fakeAh();
    const session = new AnonymousSession();
    assert.equal(calls.length, 0);
    assert.equal((await search(session)).length, 5);
    await search(session);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), [
      `POST ${TOKEN_PATH}`,
      "GET /mobile-services/product/search/v2",
      "GET /mobile-services/product/search/v2",
    ]);
    assert.deepEqual(calls[0]!.body, { clientId });
    assert.equal(calls[1]!.headers.Authorization, "Bearer ANON-1");
  });
}

// Done-when 5.
test("no tokens file is read or written", async () => {
  const home = mkdtempSync(join(tmpdir(), "ah-be-mcp-"));
  const old = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, APPDATA: home });
  try {
    fakeAh();
    await search(new AnonymousSession());
    assert.deepEqual(readdirSync(home), []);
    assert.ok(defaultTokensPath().startsWith(home));
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("a 401 renews the token once and runs the call again", async () => {
  const calls = fakeAh((call) => (call.headers.Authorization === "Bearer ANON-1" ? { status: 401, body: { message: "expired" } } : undefined));
  assert.equal((await search(new AnonymousSession())).length, 5);
  assert.equal(calls.filter((c) => c.url.pathname === TOKEN_PATH).length, 2);
  assert.equal(calls.at(-1)!.headers.Authorization, "Bearer ANON-2");
});

test("a second 401 is an error, without a third token", async () => {
  const calls = fakeAh((call) => (call.url.pathname === TOKEN_PATH ? undefined : { status: 401, body: { message: "no" } }));
  await assert.rejects(search(new AnonymousSession()), (err) => err instanceof AhApiError && err.status === 401);
  assert.equal(calls.filter((c) => c.url.pathname === TOKEN_PATH).length, 2);
  assert.equal(calls.filter((c) => c.url.pathname !== TOKEN_PATH).length, 2);
});

test("a token that expires soon is renewed before the next call", async () => {
  const calls = fakeAh((call) => (call.url.pathname === TOKEN_PATH ? { body: { access_token: `SHORT-${calls.length}`, expires_in: 5 } } : undefined));
  const session = new AnonymousSession();
  await search(session);
  await search(session);
  assert.equal(calls.filter((c) => c.url.pathname === TOKEN_PATH).length, 2);
});
