import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { type Call, fakeAh, fixture } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// Milestone M6 (spec section 2, "ah_get_bonus_group_products on be"): on ah.be the group is built from the
// bonus-filtered search; on ah.nl upstream's query stays.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

const bonusSearches = (calls: Call[]) => calls.filter((c) => c.url.pathname === "/mobile-services/product/search/v2");
const groupQueries = (calls: Call[]) => calls.filter((c) => c.url.pathname === "/graphql" && String(c.body?.query).includes("bonusPromotions"));

async function callTool(args: Record<string, unknown>, handler?: Parameters<typeof fakeAh>[0]) {
  const calls = fakeAh(handler);
  const client = await connect();
  try {
    const res = await client.callTool({ name: "ah_get_bonus_group_products", arguments: args });
    return { res, calls, client };
  } finally {
    await client.close();
  }
}

/** Ids of the recorded search products whose bonusSegmentId is this group's, over both pages. */
function recordedIds(segment: number): number[] {
  return [0, 1].flatMap((i) => fixture(`search-bonus-p${i}.be.json`).products).filter((p: any) => p.bonusSegmentId === segment).map((p: any) => p.webshopId);
}

// Done-when 1.
test("on be, a group of the bonus section returns the products whose bonusSegmentId is its id, and none other", async () => {
  configureSite("be");
  const hak = (await callTool({ segment_id: "820697" })).res.structuredContent as any;
  const ids = hak.products.map((p: any) => p.id).sort();
  assert.ok(recordedIds(820697).length >= 3, "the fixture has too few Hak products");
  assert.deepEqual(ids, recordedIds(820697).sort());
  assert.ok(hak.products.every((p: any) => p.is_bonus && p.url.startsWith("https://www.ah.be/producten/product/wi")));

  const verspakket = (await callTool({ segment_id: "819986" })).res.structuredContent as any;
  assert.deepEqual(verspakket.products.map((p: any) => p.id).sort(), recordedIds(819986).sort());
  assert.equal(new Set([...ids, ...verspakket.products.map((p: any) => p.id)]).size, ids.length + verspakket.products.length, "a product is in two groups");
});

test("on be, a group without products in the bonus search returns an empty list, not an error", async () => {
  configureSite("be");
  const { res } = await callTool({ segment_id: "815573" });
  assert.notEqual(res.isError, true);
  assert.deepEqual((res.structuredContent as any).products, []);
});

test("on be, the group comes from the bonus-filtered search, 100 products a page, and not from the GraphQL query", async () => {
  configureSite("be");
  const { calls } = await callTool({ segment_id: "820697" });
  assert.equal(groupQueries(calls).length, 0);
  const searches = bonusSearches(calls);
  assert.deepEqual(searches.map((c) => c.url.searchParams.get("page")), ["0", "1"]);
  for (const c of searches) assert.equal(c.url.searchParams.get("size"), "100");
});

test("on be, the pages are fetched once per week: a second call reuses them", async () => {
  configureSite("be");
  const calls = fakeAh();
  const client = await connect();
  try {
    for (const segment_id of ["820697", "819986", "820697"]) await client.callTool({ name: "ah_get_bonus_group_products", arguments: { segment_id } });
  } finally {
    await client.close();
  }
  assert.equal(bonusSearches(calls).length, 2);
});

test("on be, a bonus list of more than 40 pages is refused with an error, after at most 40 requests", async () => {
  configureSite("be");
  const { res, calls } = await callTool({ segment_id: "820697" }, (call) =>
    call.url.pathname === "/mobile-services/product/search/v2" ? { body: { page: { size: 100, totalElements: 50_000, totalPages: 500, number: 0 }, products: [] } } : undefined,
  );
  assert.equal(res.isError, true);
  assert.ok(bonusSearches(calls).length <= 40, `${bonusSearches(calls).length} search requests`);
});

test("on nl, upstream's group query is still used and the search is not", async () => {
  configureSite("nl");
  // M8 (spec 2a, A5): the group must be in the week's offers; the fake AH's offers are Belgian, so this one adds group 815112.
  const offers = (call: Call) =>
    call.url.pathname === "/mobile-services/bonuspage/v2/section"
      ? { body: { sectionType: "AH", sectionDescription: "Zuivel, eieren", bonusGroupOrProducts: [{ bonusGroup: { id: "815112", segmentId: 815112, segmentDescription: "Dutch group", discountDescription: "2e GRATIS", category: "Zuivel, eieren", products: [] } }] } }
      : undefined;
  const { res, calls } = await callTool({ segment_id: "815112" }, offers);
  assert.equal(groupQueries(calls).length, 1);
  assert.equal(bonusSearches(calls).length, 0);
  assert.equal((res.structuredContent as any).products.length, 13);
});

// Done-when 2. M8 (spec 2a, A5) turns the message into an error: the sentence stays, `isError` is new.
test("on be, period next is an error with an explanation, and asks AH for no products", async () => {
  configureSite("be");
  const { res, calls } = await callTool({ segment_id: "820697", period: "next" });
  assert.equal(res.isError, true);
  const text = (res.content as { text: string }[])[0]!.text;
  assert.match(text, /next week/i);
  assert.match(text, /ah\.be/);
  assert.equal(bonusSearches(calls).length + groupQueries(calls).length, 0);
});
