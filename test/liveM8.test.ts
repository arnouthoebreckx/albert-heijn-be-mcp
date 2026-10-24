import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBonusProducts, NON_FOOD_CATEGORIES } from "../src/ahapi/index.ts";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { configureSite } from "../src/site.ts";
import { call, connect } from "./toolClient.ts";

// Runs against ah.be, never in CI: `AH_LIVE=1 npm test`. M8 done-when 13 (spec 9a, item 2); its output also
// records the category list (done-when 5) and the ingredients answer (done-when 10).
const live = { skip: process.env.AH_LIVE === "1" ? false : "set AH_LIVE=1 to run against ah.be" };

afterEach(() => configureSite("be"));

const FIELDS = ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack"] as const;
const show = (row: any) => FIELDS.map((f) => `${f}=${row[f]}`).join(" ");

async function withTools<T>(fn: (tools: (name: string, args: Record<string, unknown>) => Promise<any>, client: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  configureSite("be");
  const client = await connect();
  try {
    return await fn((name, args) => call(client, name, args), client);
  } finally {
    await client.close();
  }
}

const monday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 1;
const sunday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 0;

test("live: the week, the category of every offer, and food_only", live, async () => {
  await withTools(async (tools) => {
    const week = await tools("ah_get_bonus_offers", { limit: 500 });
    console.log(`period ${week.period}: valid_from ${week.valid_from}, valid_until ${week.valid_until}, ${week.offers.length} offers`);
    assert.equal(week.period, "current");
    assert.ok(monday(week.valid_from), `${week.valid_from} is not a Monday`);
    assert.ok(sunday(week.valid_until), `${week.valid_until} is not a Sunday`);
    assert.ok(week.offers.every((o: any) => o.category), "an offer has no category");
    assert.equal(week.categories.reduce((n: number, c: any) => n + c.offer_count, 0), week.offers.length);
    console.log("categories (offers, * = non-food, dropped by food_only):");
    for (const c of week.categories) console.log(`  ${NON_FOOD_CATEGORIES.includes(c.name) ? "*" : " "} ${c.name}: ${c.offer_count}`);

    const food = await tools("ah_get_bonus_offers", { limit: 500, food_only: true });
    const dropped = week.offers.length - food.offers.length;
    console.log(`food_only: ${food.offers.length} offers, ${dropped} dropped; categories left: ${[...new Set(food.offers.map((o: any) => o.category))].join("; ")}`);
    assert.ok(food.offers.every((o: any) => !NON_FOOD_CATEGORIES.includes(o.category)), "a non-food offer came back");
    assert.ok(dropped > 0, "food_only dropped nothing");
    const one = week.categories.find((c: any) => c.offer_count > 0 && !NON_FOOD_CATEGORIES.includes(c.name))!;
    const some = await tools("ah_get_bonus_offers", { limit: 500, categories: [one.name.toUpperCase()] });
    assert.equal(some.offers.length, one.offer_count);
    const refused = await withTools((_t, client) => client.callTool({ name: "ah_get_bonus_offers", arguments: { categories: ["No such category"] } }));
    assert.equal(refused.isError, true);
  });
});

test("live: one offer of each mechanism of the week, next to the ah.be shelf price of that product", live, async () => {
  await withTools(async (tools) => {
    const { offers } = await tools("ah_get_bonus_offers", { limit: 500 });
    const byMechanism = new Map<string, any>();
    for (const o of offers) if (!byMechanism.has(o.bonus_mechanism.toLowerCase())) byMechanism.set(o.bonus_mechanism.toLowerCase(), o);
    console.log(`${byMechanism.size} mechanisms in the offers of the week; for each, the first offer:`);
    for (const [mechanism, o] of byMechanism) {
      let shelf: number[];
      let kind: string;
      if (o.id) {
        kind = `product ${o.id} ${o.title}`;
        shelf = [(await tools("ah_get_products", { product_ids: [o.id] })).products[0].price];
      } else {
        kind = `group ${o.bonus_segment_id} ${o.title} (AH's example product)`;
        const group = await tools("ah_get_bonus_group_products", { segment_id: o.bonus_segment_id, limit: 100 });
        shelf = [...new Set<number>(group.products.map((p: any) => p.price))];
      }
      console.log(`${o.bonus_mechanism} | ${kind}\n    AH: original_price=${o.original_price} bonus_price=${o.bonus_price}\n    ${show(o)} unit_price=${o.unit_price}/${o.unit_price_unit}\n    shelf price(s): ${shelf.join(", ")}`);
      if (o.pack_price === null) console.log("    (the parser returns null for this mechanism)");
      else assert.ok(shelf.includes(o.pack_price), `${o.bonus_mechanism}: pack_price ${o.pack_price} is not a shelf price of ${o.title} (${shelf})`);
    }
    // All offers: how many have a pack price that is a shelf price of their product or group.
    let checked = 0;
    let matching = 0;
    for (const o of offers.filter((o: any) => o.id).slice(0, 40)) {
      const shelf = (await tools("ah_get_products", { product_ids: [o.id] })).products[0];
      checked++;
      if (o.pack_price === null || o.pack_price === shelf.price) matching++;
      else console.log(`MISMATCH ${o.id} ${o.title} ${o.bonus_mechanism}: pack_price ${o.pack_price}, shelf ${shelf.price}`);
    }
    console.log(`product offers checked against ah_get_products: ${matching} of ${checked}`);
    assert.equal(matching, checked);
  });
});

test("live: one search row of each mechanism in the bonus search, next to its ah_get_products row", live, async () => {
  const rows = await new AnonymousSession().withClient((c) => getBonusProducts(c));
  const byMechanism = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byMechanism.has((r.bonusMechanism ?? "").toLowerCase())) byMechanism.set((r.bonusMechanism ?? "").toLowerCase(), r);
  await withTools(async (tools) => {
    console.log(`${byMechanism.size} mechanisms in the ${rows.length} bonus search rows; for each, the first row:`);
    for (const [mechanism, r] of byMechanism) {
      const shelf = (await tools("ah_get_products", { product_ids: [r.webshopId] })).products[0];
      const found = (await tools("ah_search_products", { queries: [r.title], bonus: true, limit: 30 })).searches[0].results.find((p: any) => p.id === r.webshopId);
      console.log(`${r.bonusMechanism ?? "(none)"} | ${r.webshopId} ${r.title}\n    AH: priceBeforeBonus=${r.priceBeforeBonus} currentPrice=${r.currentPrice}${r.isVirtualBundle ? " (bundle)" : ""}\n    search row: ${found ? show(found) : "not found by title"}\n    shelf row:  ${show(shelf)}`);
      assert.equal(shelf.pack_price, r.priceBeforeBonus, `${r.title}: pack_price is not the shelf price`);
      if (found) assert.deepEqual(FIELDS.map((f) => found[f]), FIELDS.map((f) => shelf[f]), `${r.title}: the search row and the shelf row differ`);
      // A deal on one pack is a price AH also sends: they must agree.
      if (shelf.deal_min_quantity === 1 && r.currentPrice) assert.ok(Math.abs(shelf.deal_total - r.currentPrice) <= 0.011, `${r.title}: deal_total ${shelf.deal_total}, AH ${r.currentPrice}`);
    }
  });
});

test("live: the largest group of the week, 25 products and its total, and an unknown segment_id", live, async () => {
  await withTools(async (tools, client) => {
    const { offers } = await tools("ah_get_bonus_offers", { limit: 500 });
    const groups = offers.filter((o: any) => o.bonus_segment_id);
    let largest = { segment: "", total: -1, title: "" };
    for (const g of groups) {
      const { total } = await tools("ah_get_bonus_group_products", { segment_id: g.bonus_segment_id, limit: 1 });
      if (total > largest.total) largest = { segment: g.bonus_segment_id, total, title: g.title };
    }
    const page = await tools("ah_get_bonus_group_products", { segment_id: largest.segment });
    console.log(`largest group of ${groups.length}: ${largest.segment} ${largest.title}: ${page.products.length} products of total ${page.total}, ${page.period} ${page.valid_from}..${page.valid_until}`);
    console.log(`first product: ${JSON.stringify(page.products[0])}`);
    assert.equal(page.products.length, Math.min(25, page.total));
    assert.ok(page.total > 25, "the largest group has no more than 25 products");
    assert.ok(page.products.every((p: any) => p.category));
    const rest = await tools("ah_get_bonus_group_products", { segment_id: largest.segment, offset: 25, limit: 100 });
    assert.equal(rest.products.length, Math.min(100, page.total - 25));

    const unknown = await client.callTool({ name: "ah_get_bonus_group_products", arguments: { segment_id: "1" } });
    console.log(`unknown segment_id: isError ${unknown.isError}: ${(unknown.content as { text: string }[])[0]!.text}`);
    assert.equal(unknown.isError, true);
    const next = await client.callTool({ name: "ah_get_bonus_group_products", arguments: { segment_id: largest.segment, period: "next" } });
    assert.equal(next.isError, true);
  });
});

test("live: does ah.be's product API return ingredients and allergens?", live, async () => {
  const id = 548746;
  const path = `/mobile-services/product/detail/v4/fir/${id}`;
  const raw = await new AnonymousSession().withClient((c) => c.request<any>(path));
  const trade = raw.tradeItem ?? {};
  console.log(`GET ${path} (x-application AHBEWEBSHOP, anonymous token removed) answers: ${Object.keys(raw).join(", ")}`);
  console.log(`tradeItem.foodAndBeverageIngredientStatement: ${JSON.stringify(String(trade.foodAndBeverageIngredientStatement).slice(0, 160))}…`);
  console.log(`tradeItem.allergenInformation[0].items[0..1]: ${JSON.stringify(trade.allergenInformation?.[0]?.items?.slice(0, 2))}`);
  await withTools(async (tools) => {
    const { products } = await tools("ah_get_products", { product_ids: [id], include_ingredients: true });
    console.log(`ah_get_products include_ingredients: ingredients ${products[0].ingredients?.length} characters, allergens ${JSON.stringify(products[0].allergens)}`);
    assert.ok(products[0].ingredients.length > 20);
    assert.ok(products[0].allergens.length > 0);
  });
});
