import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type FakeAhServer, startFakeAh } from "./fakeAhServer.ts";
import { get, cleanEnv, freePort, startServer, waitUntilUp } from "./serverProcess.ts";
import { readJson, root } from "./helpers.ts";

// Done-when 6 (spec section 7, Tests): the server as a process, over stdio and over streamable HTTP, and
// as the Docker image when AH_E2E_IMAGE names one (CI), all against a fake AH that AH_API_BASE_URL points to.

const ANONYMOUS_TOOLS: string[] = readJson("test/fixtures/tools-anonymous.snapshot.json").map((t: { name: string }) => t.name);
const IMAGE = process.env.AH_E2E_IMAGE;

/** Calls every anonymous tool and checks what the fake AH's recorded responses give back. */
async function callEveryTool(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ANONYMOUS_TOOLS);

  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  };

  const { searches } = await call("ah_search_products", { queries: ["kipfilet"], limit: 3 });
  assert.equal(searches[0].results.length, 3);
  assert.match(searches[0].results[0].url, /^https:\/\/www\.ah\.be\/producten\/product\/wi\d+/);

  const { products } = await call("ah_get_products", { product_ids: [548746], include_nutritional_info: false });
  assert.equal(products[0].title, "Vivera Plantaardige chicken tenders");

  const { offers } = await call("ah_get_bonus_offers", { limit: 5 });
  assert.equal(offers.length, 5);
  assert.ok(offers.every((o: any) => o.bonus_mechanism));

  const group = await call("ah_get_bonus_group_products", { segment_id: "820697" });
  assert.ok(group.products.length > 0);

  const alternatives = await call("ah_get_product_alternatives", { product_id: 548746, limit: 3 });
  assert.ok(alternatives.products.length > 0);

  const found = await call("ah_search_recipes", { query: "stoofvlees", limit: 3 });
  assert.equal(found.recipes.length, 3);

  const recipe = await call("ah_get_recipe", { recipe_id: found.recipes[0].id });
  assert.equal(recipe.title, "Stoofvlees met hoisin en udonnoedels");
  assert.ok(recipe.ingredients.length > 0);

  const refused = await client.callTool({ name: "ah_get_bonus_offers", arguments: { previously_bought: true } });
  assert.equal(refused.isError, true);
}

/** What the server asked the fake AH: an anonymous token once, then calls as the Belgian app with it. */
function assertAskedAsBelgianAnonymous(fake: FakeAhServer): void {
  const tokenRequests = fake.calls.filter((c) => c.url.pathname === "/mobile-auth/v1/auth/token/anonymous");
  assert.equal(tokenRequests.length, 1);
  assert.deepEqual(tokenRequests[0]?.body, { clientId: "appie-be-ios" });
  const others = fake.calls.filter((c) => c !== tokenRequests[0]);
  assert.ok(others.length >= 7);
  for (const c of others) {
    assert.equal(c.headers["x-application"], "AHBEWEBSHOP");
    assert.match(c.headers.authorization ?? "", /^Bearer ANON-\d+$/);
  }
}

describe("end to end", () => {
  let fake: FakeAhServer;
  before(async () => {
    // A container reaches the fake AH through the host, so it listens on every interface for the image.
    fake = await startFakeAh(IMAGE ? "0.0.0.0" : "127.0.0.1");
  });
  after(() => fake.close());

  test("over stdio", async () => {
    const { env, home } = cleanEnv({ AH_API_BASE_URL: fake.url });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}src/index.ts`, "--anonymous"], cwd: home, env, stderr: "ignore" }));
    try {
      await callEveryTool(client);
    } finally {
      await client.close();
    }
    assertAskedAsBelgianAnonymous(fake);
  });

  test("over streamable HTTP, and /healthz", async () => {
    fake.calls.length = 0;
    const port = await freePort();
    const server = startServer(["--transport", "streamable-http", "--anonymous"], { AH_MCP_PORT: String(port), AH_API_BASE_URL: fake.url });
    try {
      await waitUntilUp(port, { alive: () => server.child.exitCode === null });
      await overHttp(port);
    } finally {
      await server.stop();
    }
    assertAskedAsBelgianAnonymous(fake);
  });

  test("the Docker image, read-only, over streamable HTTP, and /healthz", { skip: IMAGE ? false : "set AH_E2E_IMAGE to an image to run this" }, async () => {
    fake.calls.length = 0;
    const port = await freePort();
    // The image's own defaults: --anonymous, streamable HTTP, AH_SITE=be, AH_MCP_HOST=0.0.0.0. Only the fake AH is ours.
    const container: ChildProcess = spawn(
      "docker",
      ["run", "--rm", "--read-only", "--add-host=host.docker.internal:host-gateway", "-p", `127.0.0.1:${port}:3000`, "-e", `AH_API_BASE_URL=${fake.containerUrl}`, IMAGE!],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    try {
      await waitUntilUp(port, { alive: () => container.exitCode === null });
      await overHttp(port);
    } finally {
      container.kill("SIGTERM");
      await new Promise((resolve) => (container.exitCode === null ? container.once("exit", resolve) : resolve(undefined)));
    }
    assertAskedAsBelgianAnonymous(fake);
  });
});

async function overHttp(port: number): Promise<void> {
  const health = await get("127.0.0.1", port, "/healthz");
  assert.deepEqual([health.status, health.body], [200, "ok"]);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    await callEveryTool(client);
  } finally {
    await client.close();
  }
}
