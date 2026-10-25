import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NON_FOOD_CATEGORIES } from "../src/ahapi/bonus.ts";
import { configureSite } from "../src/site.ts";
import { connect } from "./toolClient.ts";

// M9 done-when 3 (spec v9, 2b, B3): the sentences the 1.2.0 descriptions did not say, read from tools/list.

afterEach(() => configureSite("be"));

async function listed() {
  configureSite("be");
  const client = await connect();
  try {
    return new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  } finally {
    await client.close();
  }
}

/** The properties of the rows at this path of an output schema, going into the first alternative of a union. */
function rowProperties(schema: any, ...path: string[]): Record<string, { description?: string }> {
  let node = schema;
  for (const key of path) {
    node = node.properties[key].items ?? node.properties[key];
    node = node.anyOf?.[0] ?? node;
  }
  return node.properties;
}

const MEMBER = /one member's/i;

test("ah_get_bonus_offers says that on a group offer the price fields are one member's, the title names the group, and to expand the group", async () => {
  const d = (await listed()).get("ah_get_bonus_offers")!.description!;
  assert.match(d, /bonus_segment_id/);
  assert.match(d, MEMBER);
  assert.match(d, /title names the group/);
  for (const field of ["title", "pack_price", "deal_"]) assert.ok(d.includes(field), `the description does not name ${field}`);
  assert.match(d, /ah_get_bonus_group_products[^.]*(each|every) member/i);
});

test("the fields of an offer row say they are one member's for a group offer, and the title that it names the group", async () => {
  const offer = rowProperties((await listed()).get("ah_get_bonus_offers")!.outputSchema, "offers");
  assert.match(offer.title!.description ?? "", /bonus_segment_id/);
  assert.match(offer.title!.description ?? "", /name for the group, not the title of one member/);
  for (const field of ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack"]) {
    assert.match(offer[field]!.description ?? "", MEMBER, field);
    assert.match(offer[field]!.description ?? "", /bonus_segment_id/, field);
  }
});

test("the shared price fields of product rows do not carry the group-offer sentence", async () => {
  const all = await listed();
  const rows = [
    rowProperties(all.get("ah_search_products")!.outputSchema, "searches", "results"),
    rowProperties(all.get("ah_get_products")!.outputSchema, "products"),
    rowProperties(all.get("ah_get_bonus_group_products")!.outputSchema, "products"),
  ];
  for (const row of rows) {
    for (const field of ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack"]) assert.doesNotMatch(row[field]!.description ?? "", MEMBER, field);
  }
});

test("food_only leaves out exactly the three non-food categories, named, and keeps the others, such as Baby en kind and Gezondheid en sport", async () => {
  const d = (await listed()).get("ah_get_bonus_offers")!.description!;
  assert.deepEqual([...NON_FOOD_CATEGORIES], ["Huishouden", "Drogisterij", "Koken, tafelen, vrije tijd"]);
  for (const name of NON_FOOD_CATEGORIES) assert.ok(d.includes(name), `the description does not name ${name}`);
  for (const name of ["Baby en kind", "Gezondheid en sport"]) assert.ok(d.includes(name), `the description does not say that ${name} stays`);
  assert.match(d, /food_only[^.]*(exactly|only)/i);
});

test("the search rows' date fields say what they are, and that 2999-12-31 is no end date", async () => {
  const search = rowProperties((await listed()).get("ah_search_products")!.outputSchema, "searches", "results");
  assert.match(search.bonus_valid_from!.description!, /first day/i);
  assert.match(search.bonus_valid_from!.description!, /YYYY-MM-DD/);
  assert.match(search.bonus_valid_until!.description!, /last day/i);
  assert.match(search.bonus_valid_until!.description!, /2999-12-31/);
  assert.match(search.bonus_valid_until!.description!, /no end/i);
  for (const f of [search.bonus_valid_from!, search.bonus_valid_until!]) assert.match(f.description!, /null/);
});

test("what the 1.2.0 descriptions already said is still there, and is not said a second time", async () => {
  const all = await listed();
  const offers = all.get("ah_get_bonus_offers")!;
  // "categories lists every category of the week, whatever the filters": tool description and output schema.
  assert.equal(offers.description!.match(/lists every category of the week/g)?.length, 1);
  assert.match(offers.outputSchema!.properties!.categories!.description as string, /every bonus category of the week.*before any filter/i);
  // "original_price and bonus_price are for deal_min_quantity packs": output schema.
  const offer = rowProperties(offers.outputSchema, "offers");
  assert.match(offer.original_price!.description!, /deal_min_quantity packs/);
  assert.match(offer.bonus_price!.description!, /deal_min_quantity packs/);
  // "volume discounts that ah_get_bonus_offers does not list": search description, unchanged.
  const search = all.get("ah_search_products")!.description!;
  assert.equal(search.match(/volume discounts/g)?.length, 1);
  assert.match(search, /that ah_get_bonus_offers does not list/);
});
