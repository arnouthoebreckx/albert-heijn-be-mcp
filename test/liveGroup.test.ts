import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBonusGroupProducts, getBonusPeriods } from "../src/ahapi/index.ts";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { configureSite } from "../src/site.ts";
import { call, connect } from "./toolClient.ts";

// Runs against ah.be, never in CI: `AH_LIVE=1 npm test`. M6 done-when 3 (spec section 2, ah_get_bonus_group_products on be).
const live = { skip: process.env.AH_LIVE === "1" ? false : "set AH_LIVE=1 to run against ah.be" };

afterEach(() => configureSite("be"));

test("live: a current Belgian group returns products whose bonusSegmentId is the group's id", live, async () => {
  configureSite("be");
  const client = await connect();
  try {
    const { offers } = await call(client, "ah_get_bonus_offers", { limit: 200 });
    const groups = offers.filter((o: any) => o.bonus_segment_id);
    assert.ok(groups.length > 0, "no group in this week's offers");
    const session = new AnonymousSession();
    const period = (await session.withClient((c) => getBonusPeriods(c)))[0]!;
    const lines: string[] = [];
    let withProducts = 0;
    for (const g of groups.slice(0, 5)) {
      const { products } = await call(client, "ah_get_bonus_group_products", { segment_id: g.bonus_segment_id });
      // The tool's output has no bonusSegmentId; the same products at the AH layer do.
      const found = await session.withClient((c) => getBonusGroupProducts(c, g.bonus_segment_id, period));
      for (const p of found) assert.equal(String(p.bonusSegmentId), g.bonus_segment_id, `${p.title} is in another group`);
      assert.deepEqual(products.map((p: any) => p.id).sort(), found.map((p) => p.webshopId).sort());
      if (products.length > 0) withProducts++;
      lines.push(`${g.bonus_segment_id} ${g.title}: ${products.length} products, e.g. ${products[0]?.title ?? "-"}`);
    }
    console.log(lines.join("\n"));
    assert.ok(withProducts > 0, "none of the first groups returned a product");
  } finally {
    await client.close();
  }
});
