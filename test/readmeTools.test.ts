import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./helpers.ts";

// M8 done-when 15 (spec section 6): the README's list of tools names what 2a adds, in a few lines.

const tools = read("README.md").split(/^## /m).find((s) => s.startsWith("Tools\n"))!;

test("the README's Tools section names the new inputs", () => {
  assert.ok(tools, "no Tools section");
  for (const input of ["categories", "food_only", "limit", "offset", "include_images", "include_description", "include_ingredients"]) {
    assert.match(tools, new RegExp(`\`${input}(=\\w+)?\``), `the Tools section does not name ${input}`);
  }
});

test("the README's Tools section names the price fields", () => {
  for (const field of ["pack_price", "deal_min_quantity", "deal_total", "deal_price_per_pack", "unit_price"]) {
    assert.ok(tools.includes(`\`${field}\``), `the Tools section does not name ${field}`);
  }
});
