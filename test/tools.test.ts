import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root } from "./helpers.ts";

// Upstream's tools at v1.7.1, counted from `tools/list` of the unchanged code: 33.
const UPSTREAM_TOOLS = [
  "ah_add_free_text_to_shopping_list",
  "ah_add_recipe_to_shopping_list",
  "ah_add_to_favorite_list",
  "ah_add_to_shopping_list",
  "ah_clear_cart",
  "ah_clear_shopping_list",
  "ah_create_favorite_list",
  "ah_delete_favorite_list",
  "ah_get_bonus_group_products",
  "ah_get_bonus_offers",
  "ah_get_cart",
  "ah_get_delivery_slots",
  "ah_get_favorite_lists",
  "ah_get_frequent_items",
  "ah_get_last_chance_items",
  "ah_get_member_profile",
  "ah_get_order_details",
  "ah_get_orders",
  "ah_get_product_alternatives",
  "ah_get_products",
  "ah_get_receipt_details",
  "ah_get_receipts",
  "ah_get_recipe",
  "ah_get_shopping_list",
  "ah_login",
  "ah_logout",
  "ah_remove_from_cart",
  "ah_remove_from_favorite_list",
  "ah_remove_from_shopping_list",
  "ah_search_products",
  "ah_search_recipes",
  "ah_search_stores",
  "ah_update_cart_item",
];

/** Starts the server over stdio with an empty home, so no tokens file or .env of the machine is read. */
async function connect(): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), "ah-be-mcp-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home } as Record<string, string>;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}src/index.ts`], cwd: home, env, stderr: "ignore" }));
  return client;
}

// Done-when 8 (build-plan M1): upstream's behaviour is unchanged in the default, logged-in mode.
test("the default mode lists exactly upstream's tools", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), UPSTREAM_TOOLS);
  } finally {
    await client.close();
  }
});

// Done-when 3 (spec section 6).
test("serverInfo names the server albert-heijn-be-mcp", async () => {
  const client = await connect();
  try {
    assert.equal(client.getServerVersion()?.name, "albert-heijn-be-mcp");
  } finally {
    await client.close();
  }
});
