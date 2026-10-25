import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { connect } from "./toolClient.ts";

// M8 done-when 12 (spec 2a and 9a, item 1): what tools/list shows. The snapshot test of
// anonymousTools.test.ts keeps the snapshot equal to this; this test says what 2a lists, line by line, so a
// regenerated snapshot cannot carry a change that 2a does not list.

afterEach(() => configureSite("be"));

const ROW = ["id", "title", "url", "price", "bonus_price", "unit", "is_bonus", "bonus_mechanism"];
const FIELDS = ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack", "unit_price", "unit_price_unit"];

type Schema = { properties?: Record<string, any>; required?: string[] };

async function schemas() {
  configureSite("be");
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t]));
  } finally {
    await client.close();
  }
}

/** The properties of the rows at this path of an output schema, going into the first alternative of a union. */
function rows(schema: Schema, ...path: string[]): string[] {
  let node: any = schema;
  for (const key of path) {
    node = node.properties[key].items ?? node.properties[key];
    node = node.anyOf?.[0] ?? node;
  }
  return Object.keys(node.properties).sort();
}

const names = (schema: Schema | undefined) => Object.keys(schema?.properties ?? {}).sort();

test("2a lists these inputs and outputs for ah_get_bonus_offers", async () => {
  const t = (await schemas()).get("ah_get_bonus_offers")!;
  assert.deepEqual(names(t.inputSchema), ["categories", "food_only", "limit", "period", "previously_bought", "query"]);
  assert.deepEqual(names(t.outputSchema), ["categories", "offers", "period", "total", "valid_from", "valid_until"], "M9 (spec 2b, B1) adds total");
  assert.deepEqual(t.outputSchema!.required!.sort(), ["categories", "offers", "period", "total"], "valid_from and valid_until are optional: next week may not be published");
  assert.deepEqual(rows(t.outputSchema!, "categories"), ["name", "offer_count"]);
  assert.deepEqual(rows(t.outputSchema!, "offers"), ["bonus_mechanism", "bonus_price", "bonus_segment_id", "category", "discount_percentage", "id", "original_price", "title", "url", ...FIELDS, "valid_from", "valid_until"].sort());
  assert.equal((t.inputSchema.properties!.categories as any).type, "array");
  assert.equal((t.inputSchema.properties!.food_only as any).type, "boolean");
});

test("2a lists these inputs and outputs for ah_get_bonus_group_products", async () => {
  const t = (await schemas()).get("ah_get_bonus_group_products")!;
  assert.deepEqual(names(t.inputSchema), ["include_images", "limit", "offset", "period", "segment_id"]);
  assert.deepEqual(names(t.outputSchema), ["period", "products", "total", "valid_from", "valid_until"]);
  assert.deepEqual(t.outputSchema!.required!.sort(), ["period", "products", "total"]);
  assert.deepEqual(rows(t.outputSchema!, "products"), [...ROW, "category", "image_url", ...FIELDS].sort());
});

test("2a lists these inputs and outputs for ah_search_products and ah_get_products", async () => {
  const all = await schemas();
  const search = all.get("ah_search_products")!;
  assert.deepEqual(names(search.inputSchema), ["bonus", "filters", "include_images", "limit", "queries", "sort"]);
  assert.deepEqual(rows(search.outputSchema!, "searches", "results"), [...ROW, "image_url", ...FIELDS, "bonus_valid_from", "bonus_valid_until"].sort(), "M9 (spec 2b, B2) adds the two dates to search rows only");
  const products = all.get("ah_get_products")!;
  assert.deepEqual(names(products.inputSchema), ["include_description", "include_images", "include_ingredients", "include_nutritional_info", "product_ids"]);
  assert.deepEqual(
    rows(products.outputSchema!, "products"),
    ["allergens", "brand", "category", "description", "id", "image_url", "ingredients", "is_available", "is_bonus", "bonus_mechanism", "bonus_price", "nutri_score", "nutritional_info", "price", "property_icons", "title", "unit_price_description", "unit_size", "url", ...FIELDS].sort(),
  );
});

test("nothing else changes: ah_get_product_alternatives, ah_search_recipes and ah_get_recipe keep their contract", async () => {
  const all = await schemas();
  const alternatives = all.get("ah_get_product_alternatives")!;
  assert.deepEqual(names(alternatives.inputSchema), ["limit", "product_id"]);
  assert.deepEqual(rows(alternatives.outputSchema!, "products"), [...ROW, "image_url"].sort());
  assert.deepEqual([...all.keys()].sort(), ["ah_get_bonus_group_products", "ah_get_bonus_offers", "ah_get_product_alternatives", "ah_get_products", "ah_get_recipe", "ah_search_products", "ah_search_recipes"]);
  for (const t of all.values()) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});
