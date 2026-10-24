import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// M8 done-when 2 (spec 2a, A2): every offer and product row has the six price fields, and the output schemas
// say what price, original_price and bonus_price mean.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

async function withClient<T>(fn: (client: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  configureSite("be");
  fakeAh();
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return withClient(async (client) => {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    return res.structuredContent;
  });
}

const FIELDS = ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack", "unit_price", "unit_price_unit"];

test("a section product offer: the price of one pack, the deal, and the unit price", async () => {
  const { offers } = await call("ah_get_bonus_offers", { limit: 100 });
  const boerenkool = offers.find((o: any) => o.id === 51768);
  // AH sends 5.18 and 2.59 for two bags ("2 zakken"): original_price and bonus_price keep those values.
  assert.deepEqual([boerenkool.original_price, boerenkool.bonus_price], [5.18, 2.59]);
  assert.deepEqual(
    FIELDS.map((f) => boerenkool[f]),
    [2.59, 2, 2.59, 1.3, 8.63, "kg"],
  );
  const steak = offers.find((o: any) => o.title === "AH Excellent everzwijnsteak");
  assert.deepEqual(FIELDS.map((f) => steak[f]), [7.29, 1, 5.47, 5.47, 26.99, "kg"]);
});

test("a group offer takes its fields from AH's example product, and has no unit price", async () => {
  const { offers } = await call("ah_get_bonus_offers", { limit: 100 });
  const hak = offers.find((o: any) => o.bonus_segment_id === "820697");
  assert.deepEqual([hak.original_price, hak.bonus_price], [2.58, 1.29]);
  assert.deepEqual(FIELDS.map((f) => hak[f]), [1.29, 2, 1.29, 0.65, null, null]);
  const verspakket = offers.find((o: any) => o.bonus_segment_id === "819986");
  assert.deepEqual(FIELDS.map((f) => verspakket[f]), [5.99, 1, 4.99, 4.99, null, null]);
});

test("every offer has all six fields, and the deal fields are all numbers or all null", async () => {
  const { offers } = await call("ah_get_bonus_offers", { limit: 100 });
  for (const o of offers) {
    for (const f of FIELDS) assert.ok(f in o, `${o.title} has no ${f}`);
    const deal = [o.deal_min_quantity, o.deal_total, o.deal_price_per_pack];
    assert.ok(deal.every((v) => v === null) || deal.every((v) => typeof v === "number"), o.title);
  }
});

test("search rows: the deal fields are null without a deal, and a bundle's deal is read from AH's prices", async () => {
  const { searches } = await call("ah_search_products", { queries: ["kipfilet"], limit: 5 });
  const rows = searches[0].results;
  const plain = rows.find((p: any) => p.id === 548746);
  assert.deepEqual(FIELDS.map((f) => plain[f]), [3.99, null, null, null, 19.95, "kg"]);
  assert.equal(plain.price, 3.99);
  // "5% volume voordeel" on a 2-pack that AH sells as one item (isVirtualBundle): one pack is the 2-pack.
  const bundle = rows.find((p: any) => p.id === 568402);
  assert.deepEqual(FIELDS.map((f) => bundle[f]), [6.78, 1, 6.44, 6.44, null, null]);
  assert.deepEqual([bundle.price, bundle.bonus_price], [6.78, 6.44]);
});

test("product rows of ah_get_products have the six fields", async () => {
  const { products } = await call("ah_get_products", { product_ids: [548746] });
  assert.deepEqual(FIELDS.map((f) => products[0][f]), [3.99, null, null, null, 19.95, "kg"]);
});

test("group product rows have the six fields: a search row's, so a pack is one pack", async () => {
  const { products } = await call("ah_get_bonus_group_products", { segment_id: "820697" });
  assert.equal(products.length, 3);
  const prices = products.map((p: any) => [p.price, p.pack_price, p.deal_min_quantity, p.deal_total]);
  assert.deepEqual(prices.map(([price, pack]) => price === pack), [true, true, true]);
  for (const p of products) {
    assert.equal(p.deal_min_quantity, 2, "2e GRATIS needs two packs");
    assert.equal(p.deal_total, p.pack_price, "2e GRATIS: two packs cost one");
  }
});

test("the output schemas say what price, original_price and bonus_price mean", async () => {
  const { tools } = await withClient((client) => client.listTools());
  /** The properties of the rows under these keys of a tool's output schema (the first alternative of a union). */
  const rows = (name: string, ...path: string[]): Record<string, any> => {
    let node: any = tools.find((t) => t.name === name)!.outputSchema;
    for (const key of path) {
      node = node.properties[key].items ?? node.properties[key];
      node = node.anyOf?.[0] ?? node;
    }
    return node.properties;
  };
  const offer = rows("ah_get_bonus_offers", "offers");
  for (const f of ["original_price", "bonus_price"]) {
    assert.match(offer[f].description, /pack/i, f);
    assert.match(offer[f].description, /deal_min_quantity|packs the deal needs/i, f);
  }
  assert.match(offer.original_price.description + offer.bonus_price.description, /example/i, "the description says a group offer is an example product's");
  for (const [name, ...path] of [["ah_search_products", "searches", "results"], ["ah_get_products", "products"], ["ah_get_bonus_group_products", "products"]] as const) {
    const props = rows(name, ...path);
    for (const f of ["price", "bonus_price"]) assert.match(props[f].description, /pack/i, `${name} ${f}`);
    for (const f of FIELDS) assert.ok(props[f], `${name} has no ${f}`);
  }
});
