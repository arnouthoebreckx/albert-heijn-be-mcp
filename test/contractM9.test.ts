import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { connect } from "./toolClient.ts";

// M9 done-when 4 (spec 2b and 9b, item 1): what tools/list shows after v1.2.0, line by line. The snapshot test of
// anonymousTools.test.ts keeps the snapshot equal to this.

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

const names = (schema: any) => Object.keys(schema?.properties ?? {}).sort();
const rowOf = (schema: any, ...path: string[]) => {
  let node = schema;
  for (const key of path) {
    node = node.properties[key].items ?? node.properties[key];
    node = node.anyOf?.[0] ?? node;
  }
  return node;
};

test("the tool names are those of v1.2.0, and no input changes", async () => {
  const all = await listed();
  assert.deepEqual([...all.keys()].sort(), ["ah_get_bonus_group_products", "ah_get_bonus_offers", "ah_get_product_alternatives", "ah_get_products", "ah_get_recipe", "ah_search_products", "ah_search_recipes"]);
  assert.deepEqual(names(all.get("ah_get_bonus_offers")!.inputSchema), ["categories", "food_only", "limit", "period", "previously_bought", "query"]);
  assert.deepEqual(names(all.get("ah_search_products")!.inputSchema), ["bonus", "filters", "include_images", "limit", "queries", "sort"]);
});

test("B1: ah_get_bonus_offers has a required output total, whose description says before limit", async () => {
  const t = (await listed()).get("ah_get_bonus_offers")!;
  assert.deepEqual(names(t.outputSchema), ["categories", "offers", "period", "total", "valid_from", "valid_until"]);
  assert.deepEqual([...t.outputSchema!.required!].sort(), ["categories", "offers", "period", "total"]);
  const total: any = t.outputSchema!.properties!.total;
  assert.equal(total.type, "number");
  assert.match(total.description, /before `?limit`?/);
});

test("B2: a search row has bonus_valid_from and bonus_valid_until, nullable strings with descriptions", async () => {
  const row = rowOf((await listed()).get("ah_search_products")!.outputSchema, "searches", "results");
  for (const f of ["bonus_valid_from", "bonus_valid_until"]) {
    const p = row.properties[f];
    assert.deepEqual(p.anyOf.map((a: any) => a.type).sort(), ["null", "string"], f);
    assert.ok(p.description, f);
    assert.ok(row.required.includes(f), `${f} is always there, null without a date`);
  }
});

test("B2: the other rows do not get the fields", async () => {
  const all = await listed();
  const rows = [
    rowOf(all.get("ah_get_bonus_group_products")!.outputSchema, "products"),
    rowOf(all.get("ah_get_products")!.outputSchema, "products"),
    rowOf(all.get("ah_get_bonus_offers")!.outputSchema, "offers"),
    rowOf(all.get("ah_get_product_alternatives")!.outputSchema, "products"),
  ];
  for (const row of rows) assert.deepEqual(Object.keys(row.properties).filter((k) => k.startsWith("bonus_valid_")), []);
});
