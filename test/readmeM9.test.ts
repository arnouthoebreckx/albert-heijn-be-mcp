import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./helpers.ts";

// M9 done-when 7 (spec section 6): the README's list of tools names what 2b adds, in a line.

const tools = read("README.md").split(/^## /m).find((s) => s.startsWith("Tools\n"))!;
const row = (name: string) => tools.split("\n").find((l) => l.startsWith(`| \`${name}\` |`))!;

test("the README's row of ah_get_bonus_offers names total", () => {
  assert.match(row("ah_get_bonus_offers"), /`total`/);
});

test("the README's row of ah_search_products names bonus_valid_from and bonus_valid_until", () => {
  for (const field of ["bonus_valid_from", "bonus_valid_until"]) assert.match(row("ah_search_products"), new RegExp(`\`${field}\``));
});
