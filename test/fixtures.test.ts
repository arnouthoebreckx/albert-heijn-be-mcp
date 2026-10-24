import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";
import { call as tools, connect } from "./toolClient.ts";

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  configureSite("be");
  fakeAh();
  const client = await connect();
  try {
    return await tools(client, name, args);
  } finally {
    await client.close();
  }
}

// Done-when 6 (spec section 7): bonus offers, a bonus group, search and products, on recorded ah.be responses.
test("bonus offers carry the mechanism and www.ah.be links", async () => {
  const { offers } = await call("ah_get_bonus_offers", { limit: 100 });
  assert.ok(offers.length > 3);
  for (const o of offers) assert.match(o.url, /^https:\/\/www\.ah\.be\/(producten\/product\/wi\d+|bonus\/groep\/\w+)/);
  assert.ok(offers.every((o: any) => o.bonus_mechanism));
  const hak = offers.find((o: any) => o.bonus_segment_id === "820697");
  assert.equal(hak.title, "Hak*");
  assert.equal(hak.bonus_mechanism, "2e GRATIS");
  assert.equal(hak.url, "https://www.ah.be/bonus/groep/820697");
  const boerenkool = offers.find((o: any) => o.id === 51768);
  assert.deepEqual([boerenkool.original_price, boerenkool.bonus_price, boerenkool.bonus_mechanism], [5.18, 2.59, "2e gratis"]);
});

test("a bonus group lists its products with www.ah.be links", async () => {
  const { products } = await call("ah_get_bonus_group_products", { segment_id: "820697" });
  assert.equal(products.length, 3);
  assert.ok(products.every((p: any) => p.is_bonus && p.url.startsWith("https://www.ah.be/producten/product/wi")));
});

test("a search returns Belgian prices", async () => {
  const { searches } = await call("ah_search_products", { queries: ["kipfilet"], limit: 5 });
  const results = searches[0].results;
  assert.equal(results.length, 5);
  const kip = results.find((p: any) => p.id === 543332);
  assert.equal(kip.title, "AH Scharrel kipfilet naturel");
  assert.equal(kip.price, 3.49);
  assert.equal(kip.url, "https://www.ah.be/producten/product/wi543332/ah-scharrel-kipfilet-naturel");
  const promo = results.find((p: any) => p.id === 568402);
  assert.deepEqual([promo.price, promo.bonus_price, promo.bonus_mechanism], [6.78, 6.44, "5% volume voordeel"]);
});

test("products by id come back with details", async () => {
  const { products } = await call("ah_get_products", { product_ids: [548746], include_nutritional_info: false });
  assert.equal(products[0].id, 548746);
  assert.equal(products[0].title, "Vivera Plantaardige chicken tenders");
  assert.equal(products[0].price, 3.99);
  assert.equal(products[0].url, "https://www.ah.be/producten/product/wi548746/vivera-plantaardige-chicken-tenders");
});
