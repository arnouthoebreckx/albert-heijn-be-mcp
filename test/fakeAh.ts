import { mock } from "node:test";
import { existsSync } from "node:fs";
import { readJson, root } from "./helpers.ts";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; body: unknown };
type Handler = (call: Call, nth: number) => Reply | undefined;

export function fixture(name: string): any {
  return readJson(`test/fixtures/${name}`);
}

/**
 * Replaces fetch with a fake AH that answers from the recorded fixtures. `handler` may answer first
 * (to inject a 401, say); returns the calls made, in order.
 */
export function fakeAh(handler: Handler = () => undefined): Call[] {
  const calls: Call[] = [];
  let tokens = 0;
  mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const reply = handler(call, calls.length) ?? route(call, () => ++tokens);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

/** What the fake AH answers; also used by the fake AH server of the end-to-end test. */
export function route(call: Call, nextToken: () => number): Reply {
  const path = call.url.pathname;
  if (path === "/mobile-auth/v1/auth/token/anonymous") {
    return { body: { ...fixture("token-anonymous.be.json"), access_token: `ANON-${nextToken()}` } };
  }
  if (path === "/mobile-services/bonuspage/v3/metadata") return { body: fixture("bonus-metadata.be.json") };
  if (path === "/mobile-services/bonuspage/v2/section") return { body: section(call.url.searchParams.get("category") ?? "") };
  if (path === "/mobile-services/product/search/v2") {
    // The bonus-filtered search, which lists a group's products on ah.be: two recorded pages of 100 (trimmed).
    if (call.url.searchParams.get("filters") === "bonus=Bonus") return { body: fixture(`search-bonus-p${call.url.searchParams.get("page")}.be.json`) };
    return { body: fixture("search-kipfilet.be.json") };
  }
  if (path === "/mobile-services/product/detail/v4/fir/548746") return { body: fixture("product-detail.be.json") };
  if (path === "/graphql") return graphql(String(call.body?.query ?? ""));
  return { status: 404, body: { message: `no fixture for ${path}` } };
}

/** The recorded section of a category; the categories without a recorded section of their own get the first one. */
function section(category: string): unknown {
  const slug = category.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  return existsSync(`${root}test/fixtures/bonus-section.${slug}.be.json`) ? fixture(`bonus-section.${slug}.be.json`) : fixture("bonus-section.be.json");
}

function graphql(query: string): Reply {
  if (query.includes("productAlternatives")) return { body: fixture("product-alternatives.be.json") };
  if (query.includes("recipeSearch")) return { body: fixture("recipe-search.be.json") };
  if (query.includes("recipe(")) return { body: fixture("recipe.be.json") };
  // Recorded on api.ah.nl: AH answers this query with no products for every Belgian group.
  if (query.includes("bonusPromotions")) return { body: fixture("bonus-group-products.nl.json") };
  return { status: 404, body: { message: "no fixture for this GraphQL query" } };
}
