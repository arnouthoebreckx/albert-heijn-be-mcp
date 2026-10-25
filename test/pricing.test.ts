import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFields } from "../src/ahapi/pricing.ts";
import { fixture } from "./fakeAh.ts";

// M8 done-when 3 (spec 2a, A2): one meaning for prices. The parser turns the mechanism text, the row's two
// prices and the source of the row into the six fields. The rows are recorded from ah.be on 24 Oct 2026;
// `shelf` is the same product's row from ah_get_products, whose priceBeforeBonus is the price of one pack.

const rows = fixture("price-rows.be.json");
const search = (mechanism: string) => rows.search.find((r: any) => r.row.bonusMechanism === mechanism);
const section = (mechanism: string) => rows.section.find((r: any) => r.row.bonusMechanism === mechanism);
const group = (mechanism: string) => rows.group.find((r: any) => r.group.discountDescription === mechanism);

/** The fields of a recorded search row. */
const fromSearch = (r: any) =>
  priceFields({ source: "search", mechanism: r.row.bonusMechanism, was: r.row.priceBeforeBonus, now: r.row.currentPrice, unitPriceDescription: r.row.unitPriceDescription, bundle: r.row.isVirtualBundle });
const fromSection = (r: any) =>
  priceFields({ source: "section", mechanism: r.row.bonusMechanism, was: r.row.priceBeforeBonus, now: r.row.currentPrice, unitPriceDescription: r.row.unitPriceDescription });
const fromExample = (g: any) =>
  priceFields({ source: "example", mechanism: g.group.discountDescription, was: g.group.exampleFromPrice, now: g.group.exampleForPrice });

const deal = (f: ReturnType<typeof priceFields>) => [f.pack_price, f.deal_min_quantity, f.deal_total, f.deal_price_per_pack];

test("the parser's input is the mechanism, the two prices and the source of the row", () => {
  const f = priceFields({ source: "search", mechanism: "2 voor 5.50", was: 3.39, now: null });
  assert.deepEqual(Object.keys(f).sort(), ["deal_min_quantity", "deal_price_per_pack", "deal_total", "pack_price", "unit_price", "unit_price_unit"]);
});

// A search row or a product row from ah_get_products: priceBeforeBonus is one pack, whatever the mechanism.
for (const [mechanism, expected] of [
  ["2e gratis", [3.95, 2, 3.95, 1.98]],
  ["1 + 1 gratis", [1.35, 2, 1.35, 0.68]],
  ["2e Halve Prijs", [7.49, 2, 11.23, 5.62]],
  ["2 + 1 gratis", [2.89, 3, 5.78, 1.93]],
  ["3 voor 5.00", [1.69, 3, 5, 1.67]],
  ["2 voor 5.50", [3.39, 2, 5.5, 2.75]],
  ["25% korting", [1.79, 1, 1.34, 1.34]],
  ["1 euro korting", [5.99, 1, 4.99, 4.99]],
  ["VOOR 0.99", [1.49, 1, 0.99, 0.99]],
  ["5% volume voordeel", [3.58, 1, 3.4, 3.4]],
  ["10% volume voordeel", [7.98, 1, 7.18, 7.18]],
] as const) {
  test(`a search row with "${mechanism}": pack_price is the shelf price, and the deal is read from the text`, () => {
    const r = search(mechanism);
    assert.ok(r, `no recorded row for ${mechanism}`);
    const f = fromSearch(r);
    assert.equal(f.pack_price, r.shelf.priceBeforeBonus, "pack_price is not the ah_get_products price of that product");
    assert.deepEqual(deal(f), expected);
    // The product row of ah_get_products says the same as the search row.
    assert.deepEqual(fromSearch({ row: r.shelf }), fromSearch(r));
  });
}

// A product of a bonus section: priceBeforeBonus is the price of the packs the deal needs, currentPrice what they cost with the deal.
for (const [mechanism, expected] of [
  ["2e gratis", [2.59, 2, 2.59, 1.3]],
  ["2e Halve Prijs", [7.49, 2, 11.23, 5.62]],
  ["25% korting", [7.29, 1, 5.47, 5.47]],
] as const) {
  test(`a section product with "${mechanism}": the two prices are for the packs the deal needs`, () => {
    const r = section(mechanism);
    assert.ok(r, `no recorded row for ${mechanism}`);
    const f = fromSection(r);
    assert.equal(f.pack_price, r.shelf.priceBeforeBonus, "pack_price is not the ah_get_products price of that product");
    assert.deepEqual(deal(f), expected);
  });
}

test("a section product's unit price is the normal price per kg, from the recorded text", () => {
  assert.deepEqual([fromSection(section("2e gratis")).unit_price, fromSection(section("2e gratis")).unit_price_unit], [8.63, "kg"]);
});

// A group offer has no product of its own: its example product's prices, for the packs the deal needs.
for (const [mechanism, quantity] of [
  ["2e GRATIS", 2],
  ["2 + 1 GRATIS", 3],
  ["2E HALVE PRIJS", 2],
  ["2 VOOR 12.00", 2],
  ["4 VOOR 14.99", 4],
  ["25% KORTING", 1],
  ["1 EURO KORTING", 1],
] as const) {
  test(`a group example with "${mechanism}": one pack is a price of a product in the group, the total is AH's`, () => {
    const g = group(mechanism);
    assert.ok(g, `no recorded group for ${mechanism}`);
    const f = fromExample(g);
    assert.equal(f.deal_min_quantity, quantity);
    assert.equal(f.deal_total, g.group.exampleForPrice);
    assert.ok(g.shelf_prices.includes(f.pack_price), `${f.pack_price} is not among the shelf prices ${g.shelf_prices} of the group`);
    assert.equal(f.deal_price_per_pack, Math.round((f.deal_total! / quantity) * 100 + 1e-6) / 100);
    assert.deepEqual([f.unit_price, f.unit_price_unit], [null, null], "a group example has no unit price");
  });
}

test("2e Halve Prijs rounds the half price the way AH does: to the even cent", () => {
  // 7.49 / 2 = 3.745, which AH rounds to 3.74 (a pack and a half: 11.23); 2.09 / 2 = 1.045 to 1.04 (3.13).
  assert.equal(priceFields({ source: "search", mechanism: "2e Halve Prijs", was: 7.49 }).deal_total, 11.23);
  assert.equal(priceFields({ source: "example", mechanism: "2E HALVE PRIJS", was: 4.18, now: 3.13 }).deal_total, 3.13);
});

test("the mechanism is read whatever its case or spacing", () => {
  for (const m of ["2e GRATIS", "2E gratis", " 2e  gratis "]) assert.deepEqual(deal(priceFields({ source: "search", mechanism: m, was: 3.95 })), [3.95, 2, 3.95, 1.98]);
});

test("a percentage or euro discount with no currentPrice is worked out from the text, to the cent", () => {
  assert.deepEqual(deal(priceFields({ source: "search", mechanism: "25% korting", was: 7.29 })), [7.29, 1, 5.47, 5.47]);
  assert.deepEqual(deal(priceFields({ source: "search", mechanism: "1 euro korting", was: 5.99 })), [5.99, 1, 4.99, 4.99]);
});

// Never a guess.
test("a mechanism the parser does not know gives null deal fields and a pack price only where the source says it", () => {
  const unknown = "3 halen 2 betalen";
  const s = priceFields({ source: "search", mechanism: unknown, was: 3.95 });
  assert.deepEqual([s.pack_price, s.deal_min_quantity, s.deal_total, s.deal_price_per_pack], [3.95, null, null, null]);
  // In a section or a group example the two prices are for an unknown number of packs.
  for (const source of ["section", "example"] as const) {
    const f = priceFields({ source, mechanism: unknown, was: 5.18, now: 2.59 });
    assert.deepEqual(deal(f), [null, null, null, null], source);
  }
});

test("a row without a deal has a pack price and no deal fields", () => {
  const f = priceFields({ source: "search", mechanism: null, was: 3.99, now: null, unitPriceDescription: "prijs per kg €19.95" });
  assert.deepEqual(deal(f), [3.99, null, null, null]);
  assert.deepEqual([f.unit_price, f.unit_price_unit], [19.95, "kg"]);
});

test("volume voordeel: the row is a bundle sold as one item, and only then, and only when currentPrice includes the discount", () => {
  const base = { source: "search", mechanism: "5% volume voordeel", was: 3.58, now: 3.4 } as const;
  assert.deepEqual(deal(priceFields({ ...base, bundle: true })), [3.58, 1, 3.4, 3.4]);
  // AH does not say it is a bundle: the text does not say how many packs the deal needs.
  assert.deepEqual(deal(priceFields({ ...base })), [3.58, null, null, null]);
  assert.deepEqual(deal(priceFields({ ...base, bundle: false })), [3.58, null, null, null]);
  // currentPrice is not the discounted price (5% of 3.58 is 3.40): no number is better than a wrong one.
  assert.deepEqual(deal(priceFields({ ...base, bundle: true, now: 3.58 })), [3.58, null, null, null]);
  assert.deepEqual(deal(priceFields({ ...base, bundle: true, now: null })), [3.58, null, null, null]);
});

test("a section product or group example whose prices do not fit the mechanism gives null, not a guess", () => {
  // "2e gratis" with one pack's price twice: the two prices are not for two packs.
  assert.deepEqual(deal(priceFields({ source: "section", mechanism: "2e gratis", was: 2.59, now: 2.59 })), [null, null, null, null]);
  assert.deepEqual(deal(priceFields({ source: "example", mechanism: "2 VOOR 12.00", was: 13.98, now: 11 })), [null, null, null, null]);
  assert.deepEqual(deal(priceFields({ source: "section", mechanism: "2e gratis", was: 5.18 })), [null, null, null, null]);
});

test("a single-pack deal takes AH's price when the text agrees with it to the cent", () => {
  // 5.99 x 50% is 2.995; AH charges 2.99.
  assert.deepEqual(deal(priceFields({ source: "search", mechanism: "50% korting", was: 5.99, now: 2.99 })), [5.99, 1, 2.99, 2.99]);
  assert.deepEqual(deal(priceFields({ source: "search", mechanism: "50% korting", was: 5.99, now: 4.5 })), [5.99, null, null, null]);
});

test("amounts are euros rounded to cents", () => {
  const f = priceFields({ source: "search", mechanism: "3 voor 5.00", was: 1.69 });
  for (const v of [f.pack_price, f.deal_total, f.deal_price_per_pack]) assert.equal(v, Math.round(v! * 100) / 100);
});

for (const [text, expected] of [
  ["normale prijs per kg €8.63", [8.63, "kg"]],
  ["prijs per kg €19.95", [19.95, "kg"]],
  ["normale prijs per liter €15.97", [15.97, "l"]],
  ["prijs per liter €3.99", [3.99, "l"]],
  ["prijs per stuk €0.50", [0.5, "stuk"]],
  ["normale prijs per stuk €12.00", [12, "stuk"]],
  ["prijs per 100 g €1.20", [null, null]],
  [null, [null, null]],
  ["", [null, null]],
] as const) {
  test(`unit price from ${JSON.stringify(text)}`, () => {
    const f = priceFields({ source: "search", mechanism: null, was: 1, unitPriceDescription: text });
    assert.deepEqual([f.unit_price, f.unit_price_unit], expected);
  });
}
