import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configureSite } from "../src/site.ts";
import { fakeAh } from "./fakeAh.ts";
import { cleanEnv } from "./serverProcess.ts";
import { readJson, root } from "./helpers.ts";
import { connect } from "./toolClient.ts";

afterEach(() => {
  mock.restoreAll();
  configureSite("be");
});

// Spec section 2: the four required tools, and the optional ones that M2's live run showed work on ah.be
// (ah_search_stores does not: its lookup is Dutch only).
const ANONYMOUS_TOOLS = [
  "ah_get_bonus_group_products",
  "ah_get_bonus_offers",
  "ah_get_product_alternatives",
  "ah_get_products",
  "ah_get_recipe",
  "ah_search_products",
  "ah_search_recipes",
];

/** What a change must go through the spec for: names, annotations, input and output schemas. */
function contract(tools: Awaited<ReturnType<Client["listTools"]>>["tools"]) {
  return tools
    .map((t) => ({ name: t.name, annotations: t.annotations, inputSchema: t.inputSchema, outputSchema: t.outputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Done-when 1 and 2 (spec sections 2 and 7).
test("anonymous mode lists exactly the anonymous tools, as the snapshot fixes them", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ANONYMOUS_TOOLS);
    // A change here fails on purpose: it needs a change to section 2 of the spec first.
    assert.deepEqual(JSON.parse(JSON.stringify(contract(tools))), readJson("test/fixtures/tools-anonymous.snapshot.json"));
  } finally {
    await client.close();
  }
});

test("anonymous mode registers no login, member, list, cart, order, receipt, store or last-chance tool", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const forbidden = /login|logout|member|shopping_list|favorite|cart|order|receipt|last_chance|frequent|delivery|stores/;
    assert.deepEqual(tools.map((t) => t.name).filter((n) => forbidden.test(n)), []);
  } finally {
    await client.close();
  }
});

test("a server started with --anonymous lists the same tools", async () => {
  const { env, home } = cleanEnv();
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}src/index.ts`, "--anonymous"], cwd: home, env, stderr: "ignore" }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(JSON.parse(JSON.stringify(contract(tools))), readJson("test/fixtures/tools-anonymous.snapshot.json"));
  } finally {
    await client.close();
  }
});

// Done-when 3 (spec section 2).
test("previously_bought is an error in anonymous mode, and the input schema keeps it", async () => {
  const calls = fakeAh();
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const offers = tools.find((t) => t.name === "ah_get_bonus_offers");
    assert.ok((offers?.inputSchema.properties as Record<string, unknown>).previously_bought);
    const res = await client.callTool({ name: "ah_get_bonus_offers", arguments: { previously_bought: true } });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [
      { type: "text", text: "previously_bought needs a logged-in Albert Heijn account; this server runs without one" },
    ]);
    assert.equal(calls.length, 0, "AH is not asked");
    const ok = await client.callTool({ name: "ah_get_bonus_offers", arguments: { previously_bought: false, limit: 3 } });
    assert.notEqual(ok.isError, true);
  } finally {
    await client.close();
  }
});
