import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { AhClient, bonusGroupUrl, exchangeCode, getBonusSection, loginUrl, productUrl, recipeUrl } from "../src/ahapi/index.ts";
import { loadConfig } from "../src/config.ts";
import { instructions } from "../src/instructions.ts";
import { configureSite, SITES } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

// Done-when 1 (spec section 3): both columns of the table.
test("the site table has upstream's values for nl and Belgium's for be", () => {
  assert.deepEqual(SITES.nl, {
    name: "nl",
    apiBase: "https://api.ah.nl",
    loginBase: "https://login.ah.nl",
    application: "AHWEBSHOP",
    clientId: "appie-ios",
    web: "https://www.ah.nl",
  });
  assert.deepEqual(SITES.be, {
    name: "be",
    apiBase: "https://api.ah.be",
    loginBase: "https://login.ah.be",
    application: "AHBEWEBSHOP",
    clientId: "appie-be-ios",
    web: "https://www.ah.be",
  });
});

test("--site and AH_SITE pick the site, and the default is be", () => {
  assert.equal(loadConfig([], {}).site, "be");
  assert.equal(loadConfig(["--site", "nl"], {}).site, "nl");
  assert.equal(loadConfig([], { AH_SITE: "nl" }).site, "nl");
  assert.equal(loadConfig(["--site", "be"], { AH_SITE: "nl" }).site, "be");
  assert.throws(() => loadConfig(["--site", "de"], {}), /site/);
});

for (const name of ["be", "nl"] as const) {
  test(`requests use the ${name} host, header, clientId and login page`, async () => {
    const s = SITES[name];
    configureSite(name);
    const calls = fakeAh();
    await new AhClient().request("/mobile-services/product/search/v2");
    await getBonusSection(new AhClient(), "Vlees", "2026-10-19");
    await exchangeCode(new AhClient(), "code").catch(() => {});
    assert.equal(calls[0]!.url.origin, s.apiBase);
    assert.equal(calls[0]!.headers["x-application"], s.application);
    assert.equal(calls[1]!.url.searchParams.get("application"), s.application);
    assert.equal(calls[2]!.body.clientId, s.clientId);
    assert.equal(loginUrl(), `${s.loginBase}/login?client_id=${s.clientId}&response_type=code&redirect_uri=appie://login-exit`);
  });
}

// Done-when 2.
test("AH_API_BASE_URL overrides the API host", async () => {
  const cfg = loadConfig([], { AH_API_BASE_URL: "http://127.0.0.1:9999" });
  assert.equal(cfg.apiBaseUrl, "http://127.0.0.1:9999");
  configureSite(cfg.site, cfg.apiBaseUrl);
  const calls = fakeAh();
  await new AhClient().request("/mobile-services/product/search/v2");
  assert.equal(calls[0]!.url.origin, "http://127.0.0.1:9999");
  assert.equal(calls[0]!.headers["x-application"], "AHBEWEBSHOP");
});

// Done-when 3 (spec sections 2 and 3). The real ah.be paths, read from www.ah.be on 23 Oct 2026:
// /producten/product/wi585620/bambix-berenkoekjes-met-honing-1-jaar-bel and /bonus/groep/820697.
test("with be, links and the instructions point to www.ah.be", () => {
  configureSite("be");
  assert.equal(productUrl(585620, "Bambix berenkoekjes met honing 1 jaar BEL"), "https://www.ah.be/producten/product/wi585620/bambix-berenkoekjes-met-honing-1-jaar-bel");
  assert.equal(bonusGroupUrl("820697"), "https://www.ah.be/bonus/groep/820697");
  assert.equal(recipeUrl(1202271, "stoofvlees"), "https://www.ah.be/allerhande/recept/R-R1202271/stoofvlees");
  assert.match(instructions(), /https:\/\/www\.ah\.be\/producten\/product\/wi/);
  assert.doesNotMatch(instructions(), /ah\.nl/);
});

test("with nl, links and the instructions point to www.ah.nl", () => {
  configureSite("nl");
  assert.equal(bonusGroupUrl("820697"), "https://www.ah.nl/bonus/groep/820697");
  assert.match(instructions(), /https:\/\/www\.ah\.nl\/producten\/product\/wi/);
});
