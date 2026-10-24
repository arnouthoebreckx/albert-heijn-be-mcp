import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { afterEach, mock, test } from "node:test";
import { NON_FOOD_CATEGORIES } from "../src/ahapi/bonus.ts";
import { configureSite } from "../src/site.ts";
import { type Call, fakeAh, fixture } from "./fakeAh.ts";
import { read, root } from "./helpers.ts";
import { connect } from "./toolClient.ts";

// M8 done-when 1, 4 and 5 (spec 2a, A1 and A3): the week and the category of every offer, on recorded ah.be responses.

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

type Handler = Parameters<typeof fakeAh>[0];

async function offers(args: Record<string, unknown> = { limit: 100 }, handler?: Handler) {
  configureSite("be");
  const calls = fakeAh(handler);
  const client = await connect();
  try {
    const res = await client.callTool({ name: "ah_get_bonus_offers", arguments: args });
    return { res, calls, data: res.structuredContent as any, text: (res.content as { text: string }[])[0]!.text };
  } finally {
    await client.close();
  }
}

// What the fixtures hold (recorded 24 Oct 2026): the week of 19 to 25 Oct and, after it, 26 Oct to 1 Nov.
const CATEGORIES = ["Groenten, aardappelen", "Vlees", "Zuivel, eieren", "Huishouden", "Gezondheid en sport"];

// Done-when 1.
test("the bonus week of bonus-metadata.be.json is 19 to 25 Oct, in the top level of ah_get_bonus_offers", async () => {
  const { data } = await offers();
  assert.equal(data.period, "current");
  assert.equal(data.valid_from, "2026-10-19");
  assert.equal(data.valid_until, "2026-10-25");
  assert.equal(fixture("bonus-metadata.be.json").periods[0].bonusStartDate, data.valid_from);
});

test("period next returns the next week's dates, and no offer, for a week AH has published without offers", async () => {
  const { data } = await offers({ period: "next" });
  assert.deepEqual([data.period, data.valid_from, data.valid_until], ["next", "2026-10-26", "2026-11-01"]);
  assert.deepEqual(data.offers, []);
});

test("an offer carries its own valid_from and valid_until only when they differ from the week's", async () => {
  const { data } = await offers({ limit: 100 }, (call) => {
    if (call.url.pathname !== "/mobile-services/bonuspage/v2/section" || call.url.searchParams.get("category") !== "Groenten, aardappelen") return undefined;
    const section = fixture("bonus-section.be.json");
    for (const o of section.bonusGroupOrProducts) if (o.product?.webshopId === 51768) o.product.bonusStartDate = "2026-10-21";
    return { body: section };
  });
  const boerenkool = data.offers.find((o: any) => o.id === 51768);
  assert.deepEqual([boerenkool.valid_from, boerenkool.valid_until], ["2026-10-21", "2026-10-25"]);
  const same = data.offers.filter((o: any) => o.id !== 51768);
  assert.ok(same.length > 10);
  for (const o of same) assert.deepEqual([o.valid_from, o.valid_until], [undefined, undefined], o.title);
});

test("next week not published: empty offers, the same sentence, no error, and no dates", async () => {
  const { res, data, text } = await offers({ period: "next" }, (call) => {
    if (call.url.pathname !== "/mobile-services/bonuspage/v3/metadata") return undefined;
    const metadata = fixture("bonus-metadata.be.json");
    metadata.periods = metadata.periods.slice(0, 1);
    return { body: metadata };
  });
  assert.notEqual(res.isError, true);
  assert.deepEqual(data.offers, []);
  assert.equal(data.valid_from, undefined);
  assert.equal(data.valid_until, undefined);
  assert.equal(
    text,
    "Next week's bonus has not been published by Albert Heijn yet. It becomes visible on 2026-10-23. This week's bonus runs until 2026-10-25.",
  );
});

// Done-when 4.
test("every offer has the category of the section it came from, or its group's own", async () => {
  const { data } = await offers();
  const category = (title: string) => data.offers.find((o: any) => o.title === title)?.category;
  assert.equal(category("AH Boerenkool 300 gram"), "Groenten, aardappelen");
  assert.equal(category("Hak*"), "Groenten, aardappelen");
  assert.equal(category("Kipfilet 600 gram"), "Vlees");
  assert.equal(category("Blije Kip eieren"), "Zuivel, eieren");
  assert.equal(category("Mr. Propre"), "Huishouden");
  assert.equal(category("Lucovitaal, Yummygums en Disney multivitaminen"), "Gezondheid en sport");
  assert.ok(data.offers.every((o: any) => typeof o.category === "string" && o.category), "an offer has no category");
});

test("categories lists the week's categories with their offers, and the counts add up to the unfiltered offers", async () => {
  const { data } = await offers();
  assert.deepEqual(data.categories.map((c: any) => c.name), CATEGORIES);
  assert.deepEqual(data.categories.map((c: any) => c.offer_count), [5, 4, 3, 3, 1]);
  assert.equal(data.categories.reduce((n: number, c: any) => n + c.offer_count, 0), data.offers.length);
  for (const c of data.categories) assert.equal(data.offers.filter((o: any) => o.category === c.name).length, c.offer_count);
  assert.deepEqual(Object.keys(data.categories[0]).sort(), ["name", "offer_count"]);
});

test("with neither input the offers are the ones v1.1.1 returned", async () => {
  const { data } = await offers();
  const added = ["category", "valid_from", "valid_until", "pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack", "unit_price", "unit_price_unit"];
  const old = data.offers.map((o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => !added.includes(k))));
  assert.deepEqual(old, fixture("offers-v1.1.1.be.json").offers);
});

test("categories narrows the offers, matching names case-insensitively and exactly; the counts stay the week's", async () => {
  const all = (await offers()).data;
  const { data } = await offers({ limit: 100, categories: ["VLEES", "huishouden"] });
  assert.deepEqual([...new Set(data.offers.map((o: any) => o.category))].sort(), ["Huishouden", "Vlees"]);
  assert.equal(data.offers.length, 4 + 3);
  assert.deepEqual(data.categories, all.categories);
  assert.deepEqual(data.valid_from, "2026-10-19");
});

test("a category name that is not one of the week's is an error that lists the week's names", async () => {
  for (const name of ["Vleees", "Zuivel", "Fruit"]) {
    const { res, text } = await offers({ categories: ["Vlees", name] });
    assert.equal(res.isError, true, name);
    assert.ok(text.includes(name), text);
    for (const c of CATEGORIES) assert.ok(text.includes(c), `${c} is not in: ${text}`);
  }
});

// Done-when 5.
test("the fixed non-food list is in one place, and is the ah.be categories that are not food", () => {
  assert.deepEqual([...NON_FOOD_CATEGORIES].sort(), ["Drogisterij", "Huishouden", "Koken, tafelen, vrije tijd"]);
  // Either food or not (baby food and nappies, vitamins and rice bars) is kept.
  for (const kept of ["Baby en kind", "Gezondheid en sport"]) assert.ok(!NON_FOOD_CATEGORIES.includes(kept), kept);
  const files = (dir: string): string[] => readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const defining = files("src").filter((f) => read(f).includes('"Drogisterij"'));
  assert.deepEqual(defining, ["src/ahapi/bonus.ts"]);
});

/** A week with one offer in each of these categories, ah.be's names. */
function weekOf(names: string[]): Handler {
  return (call) => {
    if (call.url.pathname === "/mobile-services/bonuspage/v3/metadata") {
      const metadata = fixture("bonus-metadata.be.json");
      metadata.periods[0].tabs = [
        { description: "Alle Bonus", urlMetadataList: names.map((description) => ({ bonusType: "NATIONAL", description, untranslatedDescription: description, count: 1, url: "" })) },
      ];
      return { body: metadata };
    }
    if (call.url.pathname === "/mobile-services/bonuspage/v2/section") {
      const category = call.url.searchParams.get("category")!;
      const id = String(900000 + names.indexOf(category));
      const bonusGroup = { id, segmentId: Number(id), segmentDescription: `Offer in ${category}`, discountDescription: "2e GRATIS", category, products: [], exampleFromPrice: 2, exampleForPrice: 1, bonusStartDate: "2026-10-19", bonusEndDate: "2026-10-25" };
      return { body: { sectionType: "AH", sectionDescription: category, bonusGroupOrProducts: [{ bonusGroup }] } };
    }
    return undefined;
  };
}

const WEEK = ["Groenten, aardappelen", "Vlees", "Huishouden", "Drogisterij", "Koken, tafelen, vrije tijd", "Gezondheid en sport", "Baby en kind", "Frisdrank, sappen, water"];

test("food_only drops each category of the list and keeps the rest", async () => {
  const everything = (await offers({ limit: 100 }, weekOf(WEEK))).data;
  assert.deepEqual(everything.offers.map((o: any) => o.category).sort(), [...WEEK].sort());
  const { data } = await offers({ limit: 100, food_only: true }, weekOf(WEEK));
  const kept = data.offers.map((o: any) => o.category).sort();
  for (const dropped of NON_FOOD_CATEGORIES) assert.ok(!kept.includes(dropped), `${dropped} is kept`);
  assert.deepEqual(kept, WEEK.filter((c) => !NON_FOOD_CATEGORIES.includes(c)).sort());
  // The counts are the week's, before the filter.
  assert.deepEqual(data.categories, everything.categories);
});

test("food_only is false by default, and false keeps everything", async () => {
  const { data } = await offers({ limit: 100, food_only: false }, weekOf(WEEK));
  assert.equal(data.offers.length, WEEK.length);
});

test("categories and food_only together narrow: a non-food category asked for stays dropped", async () => {
  const { res, data } = await offers({ limit: 100, categories: ["Huishouden", "Vlees", "Baby en kind"], food_only: true }, weekOf(WEEK));
  assert.notEqual(res.isError, true);
  assert.deepEqual(data.offers.map((o: any) => o.category).sort(), ["Baby en kind", "Vlees"]);
  const none = (await offers({ limit: 100, categories: ["Huishouden"], food_only: true }, weekOf(WEEK))).data;
  assert.deepEqual(none.offers, []);
});

test("food_only on the recorded week drops the household offers and nothing else", async () => {
  const { data } = await offers({ limit: 100, food_only: true });
  assert.equal(data.offers.length, 16 - 3);
  assert.ok(data.offers.every((o: any) => o.category !== "Huishouden"));
});

test("the request count of an offers call does not grow with the new fields", async () => {
  const { calls } = await offers();
  const sections = (c: Call) => c.url.pathname === "/mobile-services/bonuspage/v2/section";
  assert.equal(calls.filter(sections).length, 5, "one request per category");
  assert.equal(calls.length, 1 + 1 + 5, "the token, the metadata and the sections");
});
