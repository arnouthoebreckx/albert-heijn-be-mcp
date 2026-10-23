import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loginUrl, searchProducts } from "../src/ahapi/index.ts";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { configureSite, SITES } from "../src/site.ts";
import { call, connect } from "./toolClient.ts";

// Runs against ah.be, never in CI: `AH_LIVE=1 npm test`. Spec sections 7 and 9; M2 done-when 7 and 8.
const live = { skip: process.env.AH_LIVE === "1" ? false : "set AH_LIVE=1 to run against ah.be" };

afterEach(() => configureSite("be"));

const be = SITES.be;
const HEADERS = { "x-client-name": "appie-ios", "x-client-version": "9.28", "Content-Type": "application/json" };

async function token(application: string, clientId: string): Promise<Response> {
  return fetch(`${be.apiBase}/mobile-auth/v1/auth/token/anonymous`, {
    method: "POST",
    headers: { ...HEADERS, "x-application": application },
    body: JSON.stringify({ clientId }),
  });
}

async function searchIds(site: "be" | "nl"): Promise<number[]> {
  configureSite(site);
  const found = await new AnonymousSession().withClient((c) => searchProducts(c, "kipfilet", 20));
  return found.map((p) => p.webshopId);
}

test("live: each of the four site values is confirmed", live, async () => {
  // API host and clientId: the host answers, the clientId is accepted, and a made-up one is refused.
  assert.equal((await token(be.application, be.clientId)).status, 200);
  assert.equal((await token(be.application, "not-a-client")).status, 400);
  // Login host: the login page of the be clientId is served.
  configureSite("be");
  const login = await fetch(loginUrl());
  assert.equal(login.status, 200);
  assert.equal(new URL(login.url).origin, be.loginBase);
  // x-application: the header, not the host, picks the assortment, and AHBEWEBSHOP is the Belgian one.
  assert.notDeepEqual(await searchIds("be"), await searchIds("nl"));
});

test("live: ah_get_bonus_offers returns offers with bonus_mechanism and ah.be links", live, async () => {
  configureSite("be");
  const client = await connect();
  try {
    const { offers } = await call(client, "ah_get_bonus_offers", { limit: 50 });
    assert.ok(offers.length > 0, "no offers");
    assert.ok(offers.some((o: any) => o.bonus_mechanism), "no bonus_mechanism");
    for (const o of offers) assert.match(o.url, /^https:\/\/www\.ah\.be\//);
    console.log(`bonus offers: ${offers.length}, e.g. ${JSON.stringify(offers[0])}`);
  } finally {
    await client.close();
  }
});

test("live: a search for kipfilet returns Belgian prices", live, async () => {
  configureSite("be");
  const client = await connect();
  try {
    const { searches } = await call(client, "ah_search_products", { queries: ["kipfilet"], limit: 10 });
    const results = searches[0].results;
    assert.ok(results.length > 0, "no results");
    for (const p of results) {
      assert.ok(p.price > 0, `no price: ${p.title}`);
      assert.match(p.url, /^https:\/\/www\.ah\.be\/producten\/product\/wi\d+/);
    }
    // The Dutch site lists other products for the same words, at other prices.
    configureSite("nl");
    const nl = await new AnonymousSession().withClient((c) => searchProducts(c, "kipfilet", 20));
    const nlPrice = new Map(nl.map((p) => [p.webshopId, p.priceBeforeBonus ?? p.currentPrice]));
    const shared = results.filter((p: any) => nlPrice.has(p.id));
    assert.ok(shared.length === 0 || shared.some((p: any) => p.price !== nlPrice.get(p.id)), "prices equal the Dutch ones");
    console.log(results.map((p: any) => `${p.id} ${p.title} €${p.price}${p.bonus_price ? ` (now €${p.bonus_price})` : ""}`).join("\n"));
  } finally {
    await client.close();
  }
});

// Done-when 8: reports what the optional tools do without a login; it fails only if a call throws.
test("live: which optional tools work on ah.be without a login", live, async () => {
  configureSite("be");
  const client = await connect();
  try {
    const report: string[] = [];
    const seed = (await call(client, "ah_search_products", { queries: ["kipfilet"], limit: 1 })).searches[0].results[0].id;
    const alt = await call(client, "ah_get_product_alternatives", { product_id: seed });
    report.push(`ah_get_product_alternatives: ${alt.products.length} products for ${seed}`);
    const recipes = await call(client, "ah_search_recipes", { query: "stoofvlees", limit: 3 });
    report.push(`ah_search_recipes: ${recipes.recipes.length} of ${recipes.total} recipes`);
    const recipe = await call(client, "ah_get_recipe", { recipe_id: recipes.recipes[0].id });
    report.push(`ah_get_recipe: ${recipe.title}, ${recipe.ingredients.length} ingredients`);
    const stores = await call(client, "ah_search_stores", { postal_code: "9000" });
    report.push(`ah_search_stores 9000 (Ghent): ${stores.stores.map((s: any) => s.name).join("; ") || "none"}`);
    const { offers } = await call(client, "ah_get_bonus_offers", { limit: 200 });
    const groups = offers.filter((o: any) => o.bonus_segment_id);
    let empty = 0;
    for (const g of groups.slice(0, 10)) {
      const { products } = await call(client, "ah_get_bonus_group_products", { segment_id: g.bonus_segment_id });
      if (products.length === 0) empty++;
    }
    report.push(`ah_get_bonus_group_products: ${empty} of ${Math.min(groups.length, 10)} groups returned no products`);
    console.log(report.join("\n"));
  } finally {
    await client.close();
  }
});
