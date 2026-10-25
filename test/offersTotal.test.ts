import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { fakeAh, fixture } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// M9 done-when 1 (spec 2b, B1): ah_get_bonus_offers says how many offers match, before limit.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

async function offers(args: Record<string, unknown>, handler?: Parameters<typeof fakeAh>[0]) {
  configureSite("be");
  fakeAh(handler);
  const client = await connect();
  try {
    const res = await client.callTool({ name: "ah_get_bonus_offers", arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    return res.structuredContent as any;
  } finally {
    await client.close();
  }
}

const unlimited = { limit: 1000 };

/** The recorded week has 16 offers; this one has 24: the section of Vlees is answered with its offers cloned four times under new ids (AH had 77 on 25 Oct). */
const bigWeek: Parameters<typeof fakeAh>[0] = (call) => {
  if (call.url.pathname !== "/mobile-services/bonuspage/v2/section" || call.url.searchParams.get("category") !== "Vlees") return undefined;
  const section = fixture("bonus-section.vlees.be.json");
  const extra = [];
  for (let n = 1; n <= 4; n++) {
    for (const o of section.bonusGroupOrProducts) {
      if (!o.product) continue;
      extra.push({ ...o, product: { ...o.product, webshopId: o.product.webshopId + n * 1_000_000 } });
    }
  }
  section.bonusGroupOrProducts.push(...extra);
  return { body: section };
};

test("with the default limit and more than 20 offers in the week, offers has 20 and total is the whole number", async () => {
  const all = await offers(unlimited, bigWeek);
  assert.ok(all.offers.length > 20, `the week holds ${all.offers.length} offers`);
  const dflt = await offers({}, bigWeek);
  assert.equal(dflt.offers.length, 20);
  assert.equal(dflt.total, all.offers.length);
  assert.deepEqual(dflt.offers, all.offers.slice(0, 20), "the offers are the ones v1.2.0 returned");
});

test("total is the same for limit 5, and equals offers.length of the same call with limit above the total", async () => {
  const all = await offers(unlimited, bigWeek);
  const five = await offers({ limit: 5 }, bigWeek);
  assert.equal(five.offers.length, 5);
  assert.equal(five.total, all.total);
  assert.equal(all.total, all.offers.length);
});

test("total follows food_only, one categories name and query: it equals the length of the unlimited call", async () => {
  const week = await offers(unlimited);
  const category = week.categories.find((c: any) => c.offer_count > 0 && c.name !== "Huishouden")!.name;
  const word = week.offers[0].title.split(" ").find((w: string) => w.length > 3)!.toLowerCase();
  for (const filter of [{ food_only: true }, { categories: [category] }, { query: word }, { food_only: true, categories: [category], query: word }]) {
    const some = await offers({ ...filter, limit: 2 });
    const rest = await offers({ ...filter, ...unlimited });
    assert.ok(rest.offers.length > 0, JSON.stringify(filter));
    assert.equal(some.total, rest.offers.length, JSON.stringify(filter));
    assert.equal(rest.total, rest.offers.length, JSON.stringify(filter));
  }
  const food = await offers({ food_only: true, ...unlimited });
  assert.ok(food.total < week.total, "food_only drops offers of the fixtures");
});

test("a filter that matches nothing gives total 0", async () => {
  const none = await offers({ query: "zzzzz-no-such-product" });
  assert.deepEqual([none.total, none.offers], [0, []]);
});

test("next week not published: total 0, empty offers, the unchanged sentence", async () => {
  configureSite("be");
  fakeAh((call) => {
    if (call.url.pathname !== "/mobile-services/bonuspage/v3/metadata") return undefined;
    const metadata = fixture("bonus-metadata.be.json");
    metadata.periods = metadata.periods.slice(0, 1);
    return { body: metadata };
  });
  const client = await connect();
  try {
    const res = await client.callTool({ name: "ah_get_bonus_offers", arguments: { period: "next" } });
    assert.notEqual(res.isError, true);
    assert.equal((res.structuredContent as any).total, 0);
    assert.deepEqual((res.structuredContent as any).offers, []);
    assert.equal(
      (res.content as { text: string }[])[0]!.text,
      "Next week's bonus has not been published by Albert Heijn yet. It becomes visible on 2026-10-23. This week's bonus runs until 2026-10-25.",
    );
  } finally {
    await client.close();
  }
});

test("period next, published without offers: total 0", async () => {
  assert.equal((await offers({ period: "next" })).total, 0);
});
