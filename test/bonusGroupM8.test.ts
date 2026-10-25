import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { type Call, fakeAh, fixture } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// M8 done-when 1, 6, 7 and 8 (spec 2a, A1, A3, A4 and A5) for ah_get_bonus_group_products, on recorded ah.be responses.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

type Handler = Parameters<typeof fakeAh>[0];

async function group(args: Record<string, unknown>, handler?: Handler) {
  configureSite("be");
  const calls = fakeAh(handler);
  const client = await connect();
  try {
    const res = await client.callTool({ name: "ah_get_bonus_group_products", arguments: args });
    return { res, calls, data: res.structuredContent as any, text: (res.content as { text: string }[])[0]!.text };
  } finally {
    await client.close();
  }
}

/** The bonus search with this many products in the group 820697, 100 to a page. */
function bigGroup(count: number, reverse = false): Handler {
  const product = (i: number) => ({ ...fixture("search-bonus-p0.be.json").products.find((p: any) => p.bonusSegmentId === 820697), webshopId: 700000 + i, title: `Hak product ${i}` });
  return (call) => {
    if (call.url.pathname !== "/mobile-services/product/search/v2" || call.url.searchParams.get("filters") !== "bonus=Bonus") return undefined;
    const page = Number(call.url.searchParams.get("page"));
    const all = Array.from({ length: count }, (_, i) => product(i));
    const products = all.slice(page * 100, page * 100 + 100);
    return { body: { page: { size: 100, totalElements: count, totalPages: Math.ceil(count / 100), number: page }, products: reverse ? products.reverse() : products } };
  };
}

// Done-when 1.
test("the group tool returns the week: period, valid_from and valid_until", async () => {
  const { data } = await group({ segment_id: "820697" });
  assert.deepEqual([data.period, data.valid_from, data.valid_until], ["current", "2026-10-19", "2026-10-25"]);
});

// Done-when 6.
test("every product has the bonus category of its group, not its own mainCategory", async () => {
  const { data } = await group({ segment_id: "820697" });
  assert.equal(data.products.length, 3);
  assert.deepEqual(data.products.map((p: any) => p.category), ["Groenten, aardappelen", "Groenten, aardappelen", "Groenten, aardappelen"]);
  // The recorded products of this group say Fruit, verse sappen themselves.
  const own = fixture("search-bonus-p0.be.json").products.filter((p: any) => p.bonusSegmentId === 820697).map((p: any) => p.mainCategory);
  assert.ok(own.includes("Fruit, verse sappen"));
  const verspakket = (await group({ segment_id: "819986" })).data;
  assert.ok(verspakket.products.every((p: any) => p.category === "Groenten, aardappelen"));
});

// Done-when 7.
test("limit and offset page the group, total is the whole group, and two pages do not overlap", async () => {
  const whole = (await group({ segment_id: "820697" })).data;
  assert.equal(whole.total, 3);
  const first = (await group({ segment_id: "820697", limit: 2 })).data;
  const second = (await group({ segment_id: "820697", limit: 2, offset: 2 })).data;
  assert.deepEqual([first.products.length, second.products.length, first.total, second.total], [2, 1, 3, 3]);
  const ids = [...first.products, ...second.products].map((p: any) => p.id);
  assert.equal(new Set(ids).size, 3, "the pages overlap");
  assert.deepEqual(ids, whole.products.map((p: any) => p.id), "the pages are not the whole group in its order");
});

test("an offset past the end returns no products and the right total, and no error", async () => {
  const { res, data } = await group({ segment_id: "820697", offset: 10 });
  assert.notEqual(res.isError, true);
  assert.deepEqual([data.products, data.total], [[], 3]);
});

test("limit is 25 by default and at most 100, and the order does not depend on the order AH sends", async () => {
  const dflt = (await group({ segment_id: "820697" }, bigGroup(150))).data;
  assert.deepEqual([dflt.products.length, dflt.total], [25, 150]);
  const capped = (await group({ segment_id: "820697", limit: 1000 }, bigGroup(150))).data;
  assert.deepEqual([capped.products.length, capped.total], [100, 150]);
  const reversed = (await group({ segment_id: "820697", limit: 1000 }, bigGroup(150, true))).data;
  assert.deepEqual(reversed.products.map((p: any) => p.id), capped.products.map((p: any) => p.id));
  const rest = (await group({ segment_id: "820697", limit: 100, offset: 100 }, bigGroup(150))).data;
  assert.equal(rest.products.length, 50);
  assert.equal(new Set([...capped.products, ...rest.products].map((p: any) => p.id)).size, 150);
});

// Done-when 8.
test("period next on be is an error that says what to do, and AH is not asked for products", async () => {
  const { res, calls, text } = await group({ segment_id: "820697", period: "next" });
  assert.equal(res.isError, true);
  assert.match(text, /next week/i);
  assert.match(text, /ah\.be/);
  assert.match(text, /period='current'/);
  assert.equal(calls.filter((c) => c.url.pathname === "/mobile-services/product/search/v2").length, 0);
});

test("a segment_id that is not in the week's offers is an error, and the server logs a WARN", async () => {
  const lines: string[] = [];
  mock.method(process.stderr, "write", (chunk: unknown) => (lines.push(String(chunk)), true));
  const { res, text } = await group({ segment_id: "999999" });
  mock.restoreAll();
  assert.equal(res.isError, true);
  assert.match(text, /^no bonus group 999999 in the current bonus week\. /);
  assert.match(text, /ah_get_bonus_offers/, "the sentence says what to do");
  assert.ok(lines.some((l) => l.includes("level=WARN") && l.includes("999999")), lines.join(""));
});

test("a group in the week's offers with no products is empty and not an error", async () => {
  const { res, data } = await group({ segment_id: "815573" });
  assert.notEqual(res.isError, true);
  assert.deepEqual([data.products, data.total], [[], 0]);
  assert.equal(data.period, "current");
});

test("a group call reads the week's offers and the bonus pages on a cold cache, and nothing on a warm one", async () => {
  configureSite("be");
  const calls = fakeAh();
  const client = await connect();
  try {
    await client.callTool({ name: "ah_get_bonus_group_products", arguments: { segment_id: "820697" } });
    const cold = calls.length;
    const kinds = (list: Call[]) => list.map((c) => c.url.pathname.split("/").slice(-1)[0]);
    // The token, the metadata, 5 sections, 2 bonus pages.
    assert.equal(cold, 1 + 1 + 5 + 2, kinds(calls).join(" "));
    await client.callTool({ name: "ah_get_bonus_group_products", arguments: { segment_id: "819986" } });
    await client.callTool({ name: "ah_get_bonus_offers", arguments: {} });
    assert.equal(calls.length, cold, "a warm call asks AH again");
  } finally {
    await client.close();
  }
});
