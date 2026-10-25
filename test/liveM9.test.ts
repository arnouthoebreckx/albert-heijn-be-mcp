import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBonusProducts } from "../src/ahapi/index.ts";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { configureSite } from "../src/site.ts";
import { call, connect } from "./toolClient.ts";

// Runs against ah.be, never in CI: `AH_LIVE=1 npm test`. M9 done-when 5 (spec 9b, item 2).
const live = { skip: process.env.AH_LIVE === "1" ? false : "set AH_LIVE=1 to run against ah.be" };

afterEach(() => configureSite("be"));

async function withTools<T>(fn: (tools: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  configureSite("be");
  const client = await connect();
  try {
    return await fn((name, args) => call(client, name, args));
  } finally {
    await client.close();
  }
}

test("live: total on ah_get_bonus_offers with the default limit, food_only and one category, each next to the unlimited call", live, async () => {
  await withTools(async (tools) => {
    const week = await tools("ah_get_bonus_offers", { limit: 1000 });
    console.log(`run of ${new Date().toISOString().slice(0, 10)}; the week: ${week.period} ${week.valid_from}..${week.valid_until}, total ${week.total}, ${week.offers.length} offers returned with limit 1000`);
    assert.equal(week.total, week.offers.length);
    const category = [...week.categories].sort((a: any, b: any) => b.offer_count - a.offer_count)[0].name;
    for (const [label, args] of [
      ["default limit", {}],
      ["food_only: true", { food_only: true }],
      [`categories: ["${category}"]`, { categories: [category] }],
    ] as const) {
      const some = await tools("ah_get_bonus_offers", args);
      const rest = await tools("ah_get_bonus_offers", { ...args, limit: 1000 });
      console.log(`${label}: offers returned ${some.offers.length}, total ${some.total}; unlimited call: total ${rest.total}, ${rest.offers.length} offers`);
      assert.equal(some.total, rest.total);
      assert.equal(rest.total, rest.offers.length);
      assert.equal(some.offers.length, Math.min(20, some.total));
    }
    assert.ok(week.total > 20, "the week has no more than 20 offers: the default limit hides nothing");
  });
});

test("live: dates on the rows of ah_search_products with bonus: true, one row of the current week and one of next week", live, async () => {
  const raw = await new AnonymousSession().withClient((c) => getBonusProducts(c));
  await withTools(async (tools) => {
    const week = await tools("ah_get_bonus_offers", { limit: 1 });
    const both = raw.filter((r) => r.bonusStartDate && r.bonusEndDate);
    console.log(`run of ${new Date().toISOString().slice(0, 10)}; week ${week.valid_from}..${week.valid_until}; bonus rows of the run: ${raw.length}, with both dates: ${both.length}`);
    assert.ok(both.length > 0, "ah.be's search answer has no dates: B2 is description-only, stop (spec 2b)");
    const starts = (r: (typeof raw)[number]) => r.bonusStartDate!;
    const current = both.find((r) => starts(r) <= week.valid_until && r.bonusEndDate! >= week.valid_from);
    const next = both.find((r) => starts(r) > week.valid_until);
    const open = both.filter((r) => r.bonusEndDate!.startsWith("2999"));
    console.log(`rows without a deal in the bonus search: ${raw.filter((r) => !r.isBonus).length}; open-ended rows (2999-12-31): ${open.length}`);
    for (const [label, r] of [["current week", current], ["next week", next]] as const) {
      if (!r) {
        console.log(`${label}: no row came back in the run of ${new Date().toISOString().slice(0, 10)}`);
        continue;
      }
      const found = (await tools("ah_search_products", { queries: [r.title], bonus: true, limit: 30 })).searches[0].results.find((p: any) => p.id === r.webshopId);
      console.log(`${label}: ${r.webshopId} ${r.title} | ${r.bonusMechanism}\n    AH: bonusStartDate=${r.bonusStartDate} bonusEndDate=${r.bonusEndDate}\n    ah_search_products row: ${found ? `bonus_valid_from=${found.bonus_valid_from} bonus_valid_until=${found.bonus_valid_until}` : "not found by title"}`);
      assert.ok(found, `${r.title} not found by its title`);
      assert.deepEqual([found.bonus_valid_from, found.bonus_valid_until], [r.bonusStartDate, r.bonusEndDate]);
    }
    assert.ok(current, "no row of the current week");
    const plain = (await tools("ah_search_products", { queries: ["kipfilet"], limit: 30 })).searches[0].results.find((p: any) => !p.is_bonus);
    if (plain) {
      console.log(`a row without a deal: ${plain.id} ${plain.title}: bonus_valid_from=${plain.bonus_valid_from} bonus_valid_until=${plain.bonus_valid_until}`);
      assert.deepEqual([plain.bonus_valid_from, plain.bonus_valid_until], [null, null]);
    }
  });
});
