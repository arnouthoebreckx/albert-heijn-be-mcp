import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { configureSite } from "../src/site.ts";
import { fakeAh, fixture } from "./fakeAh.ts";
import { connect } from "./toolClient.ts";

// M9 done-when 2 (spec 2b, B2): a search row with a deal says when the deal runs, as AH's search answer gives it.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

type Handler = Parameters<typeof fakeAh>[0];

async function tool(name: string, args: Record<string, unknown>, handler?: Handler) {
  configureSite("be");
  fakeAh(handler);
  const client = await connect();
  try {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    return res.structuredContent as any;
  } finally {
    await client.close();
  }
}

/** The bonus search answers with this recorded page (the fake answers page 0 of the bonus search with search-bonus-p0). */
const page = (name: string, edit?: (rows: any[]) => void): Handler => (call) => {
  if (call.url.pathname !== "/mobile-services/product/search/v2" || call.url.searchParams.get("filters") !== "bonus=Bonus") return undefined;
  const body = fixture(name);
  edit?.(body.products);
  return { body };
};

const bonusRows = async (name = "search-bonus-p0.be.json", edit?: (rows: any[]) => void) =>
  (await tool("ah_search_products", { queries: ["bonus"], bonus: true, limit: 30 }, page(name, edit))).searches[0].results;
const dates = (row: any) => [row.bonus_valid_from, row.bonus_valid_until];

test("a row of the current week: '3 voor 5.00' runs 19 to 25 Oct", async () => {
  const row = (await bonusRows()).find((r: any) => r.id === 502305);
  assert.equal(row.bonus_mechanism, "3 voor 5.00");
  assert.deepEqual(dates(row), ["2026-10-19", "2026-10-25"]);
});

test("a row that starts on 24 Oct", async () => {
  const row = (await bonusRows()).find((r: any) => r.id === 604680);
  assert.deepEqual(dates(row), ["2026-10-24", "2026-10-25"]);
});

test("an open-ended row keeps AH's 2999-12-31", async () => {
  const row = (await bonusRows("search-bonus-p1.be.json")).find((r: any) => r.id === 579212);
  assert.deepEqual(dates(row), ["2026-10-24", "2999-12-31"]);
});

test("every deal row of both recorded pages carries both dates, as AH sends them", async () => {
  for (const name of ["search-bonus-p0.be.json", "search-bonus-p1.be.json"]) {
    const sent = fixture(name).products;
    const rows = await bonusRows(name);
    assert.equal(rows.length, sent.length);
    for (const [i, r] of rows.entries()) assert.deepEqual(dates(r), [sent[i].bonusStartDate, sent[i].bonusEndDate], `${name} ${r.id}`);
  }
});

test("a row without a deal has null and null", async () => {
  const { searches } = await tool("ah_search_products", { queries: ["kipfilet"], limit: 5 });
  const row = searches[0].results.find((r: any) => r.id === 543332);
  assert.equal(row.is_bonus, false);
  assert.deepEqual(dates(row), [null, null]);
  assert.ok("bonus_valid_from" in row && "bonus_valid_until" in row, "the keys are there, with null");
});

test("a deal row in a plain search has its dates too", async () => {
  const { searches } = await tool("ah_search_products", { queries: ["kipfilet"], limit: 5 });
  const row = searches[0].results.find((r: any) => r.id === 568402);
  assert.deepEqual(dates(row), ["2026-10-23", "2999-12-31"]);
});

test("a deal row whose dates AH leaves out has null and null", async () => {
  const rows = await bonusRows("search-bonus-p0.be.json", (all) => {
    for (const r of all) if (r.webshopId === 502305) delete r.bonusStartDate, delete r.bonusEndDate;
  });
  const row = rows.find((r: any) => r.id === 502305);
  assert.equal(row.is_bonus, true);
  assert.deepEqual(dates(row), [null, null]);
  assert.deepEqual(dates(rows.find((r: any) => r.id === 604680)), ["2026-10-24", "2026-10-25"]);
});

test("the server does not filter search rows by week: a row of next week comes back", async () => {
  const rows = await bonusRows("search-bonus-p0.be.json", (all) => {
    all[0].bonusStartDate = "2026-10-26";
    all[0].bonusEndDate = "2026-11-01";
  });
  assert.equal(rows.length, 6);
  assert.deepEqual(dates(rows[0]), ["2026-10-26", "2026-11-01"]);
});

test("group product rows, ah_get_products and the offers do not get the fields", async () => {
  const group = await tool("ah_get_bonus_group_products", { segment_id: "820697" });
  const products = await tool("ah_get_products", { product_ids: [548746] });
  const offers = await tool("ah_get_bonus_offers", { limit: 100 });
  for (const row of [...group.products, ...products.products, ...offers.offers]) {
    assert.ok(!("bonus_valid_from" in row) && !("bonus_valid_until" in row), JSON.stringify(row));
  }
});
