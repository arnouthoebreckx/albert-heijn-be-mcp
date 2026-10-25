import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// M8 done-when 9, 10 and 11 (spec 2a, A6, A7 and A8): leaner output, ingredients and allergens, descriptions.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

type Result = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["callTool"]>>;

async function call(name: string, args: Record<string, unknown>): Promise<Result & { data: any; text: string }> {
  configureSite("be");
  fakeAh();
  const client = await connect();
  try {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    return { ...res, data: res.structuredContent, text: (res.content as { text: string }[])[0]!.text };
  } finally {
    await client.close();
  }
}

// Done-when 9.
test("image_url is only in a row with include_images: true, in search, products and group products", async () => {
  for (const [name, args, rows] of [
    ["ah_search_products", { queries: ["kipfilet"], limit: 5 }, (d: any) => d.searches[0].results],
    ["ah_get_products", { product_ids: [548746] }, (d: any) => d.products],
    ["ah_get_bonus_group_products", { segment_id: "820697" }, (d: any) => d.products],
  ] as const) {
    const without = rows((await call(name, args)).data);
    assert.ok(without.length > 0, name);
    for (const r of without) assert.equal("image_url" in r, false, `${name} has image_url without include_images`);
    for (const flag of [false, undefined]) {
      for (const r of rows((await call(name, { ...args, include_images: flag })).data)) assert.equal(r.image_url, undefined, name);
    }
    const withImages = rows((await call(name, { ...args, include_images: true })).data);
    assert.ok(withImages.some((r: any) => /^https:\/\/static\.ah\.nl\//.test(r.image_url)), `${name} has no image_url with include_images`);
  }
});

test("ah_get_products returns the description only with include_description: true", async () => {
  assert.equal("description" in (await call("ah_get_products", { product_ids: [548746] })).data.products[0], false);
  const { data } = await call("ah_get_products", { product_ids: [548746], include_description: true });
  assert.match(data.products[0].description, /Plantaardige chicken tenders/);
});

test("the text copy in content is compact JSON, and equals structuredContent, for every changed tool", async () => {
  for (const [name, args] of [
    ["ah_get_bonus_offers", { limit: 100 }],
    ["ah_get_bonus_group_products", { segment_id: "820697" }],
    ["ah_search_products", { queries: ["kipfilet"], limit: 5 }],
    ["ah_get_products", { product_ids: [548746], include_nutritional_info: false }],
  ] as const) {
    const res = await call(name, args);
    assert.ok(!res.text.includes("\n"), `${name}: the text has a line break`);
    assert.equal(res.text, JSON.stringify(JSON.parse(res.text)), `${name}: the text is not compact`);
    assert.deepEqual(JSON.parse(res.text), res.structuredContent, `${name}: the text is not structuredContent`);
  }
});

// Done-when 10 (the live run, in the pull request, shows that ah.be's product API returns both).
test("include_ingredients adds the ingredients text and the allergens, and is false by default", async () => {
  const plain = (await call("ah_get_products", { product_ids: [548746] })).data.products[0];
  assert.deepEqual([plain.ingredients, plain.allergens], [undefined, undefined]);
  const { data } = await call("ah_get_products", { product_ids: [548746], include_ingredients: true });
  const p = data.products[0];
  assert.match(p.ingredients, /^Ingrediënten: 62% gehydrateerde plantaardige eiwitten/);
  assert.deepEqual(p.allergens.filter((a: any) => a.level === "contains").map((a: any) => a.name), ["Soja", "Eieren", "Tarwe", "Glutenbevattende Granen"]);
  assert.deepEqual(p.allergens.filter((a: any) => a.level === "may_contain").map((a: any) => a.name), ["Gerst", "Haver", "Melk"]);
});

// Done-when 11.
test("tools/list: ah_search_products says bonus: true also finds product promotions that the offers list does not", async () => {
  configureSite("be");
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "ah_search_products")!;
    assert.match(search.description!, /bonus=true/);
    assert.match(search.description!, /volume/i);
    assert.match(search.description!, /ah_get_bonus_offers/);
    assert.match(search.description!, /does not list|doesn't list|not listed/i);
    const offers = tools.find((t) => t.name === "ah_get_bonus_offers")!;
    for (const word of ["categories", "food_only"]) assert.ok(offers.description!.includes(word), `the description of ah_get_bonus_offers does not name ${word}`);
    assert.match(offers.description!, /offer_count|number of offers/i, "it does not name the categories output");
  } finally {
    await client.close();
  }
});
