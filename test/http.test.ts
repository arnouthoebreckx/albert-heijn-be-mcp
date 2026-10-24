import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.ts";
import { freePort, get, startServer, waitUntilUp } from "./serverProcess.ts";

const TOKEN = "t".repeat(40);

// Done-when 4 (spec section 5): the host and port settings.
test("the HTTP server listens on 127.0.0.1:3000 unless AH_MCP_HOST and AH_MCP_PORT say otherwise", () => {
  const args = ["--transport", "streamable-http", "--anonymous"];
  const fromDefaults = loadConfig(args, {});
  assert.deepEqual([fromDefaults.http.host, fromDefaults.http.port, fromDefaults.http.secret], ["127.0.0.1", 3000, undefined]);
  const set = loadConfig(args, { AH_MCP_HOST: "0.0.0.0", AH_MCP_PORT: "8080" });
  assert.deepEqual([set.http.host, set.http.port], ["0.0.0.0", 8080]);
});

test("--transport streamable-http --anonymous starts without AH_MCP_TOKEN or OAuth, and serves /mcp", async () => {
  const port = await freePort();
  const server = startServer(["--transport", "streamable-http", "--anonymous"], { AH_MCP_PORT: String(port) });
  try {
    await waitUntilUp(port, { alive: () => server.child.exitCode === null });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      assert.equal((await client.listTools()).tools.length, 7);
    } finally {
      await client.close();
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/authorize", "/register"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, `${path} is not served`);
    }
  } finally {
    await server.stop();
  }
});

test("AH_MCP_HOST picks the interface", async () => {
  const port = await freePort();
  // 127.0.0.2 is loopback too, but only a server listening on it answers there.
  const server = startServer(["--transport", "streamable-http", "--anonymous"], { AH_MCP_PORT: String(port), AH_MCP_HOST: "127.0.0.2" });
  try {
    // The local-only Host check wants the base URL's host, which is localhost.
    await waitUntilUp(port, { host: "127.0.0.2", hostHeader: `localhost:${port}`, alive: () => server.child.exitCode === null });
    await assert.rejects(get("127.0.0.1", port, "/healthz"), "nothing listens on 127.0.0.1");
  } finally {
    await server.stop();
  }
});

// Done-when 4: without --anonymous the mode is upstream's.
test("without --anonymous, the HTTP server still needs AH_MCP_TOKEN", async () => {
  const server = startServer(["--transport", "streamable-http"], { AH_MCP_PORT: String(await freePort()) });
  const code = await new Promise((resolve) => server.child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(server.stderr(), /AH_MCP_TOKEN/);
});

test("without --anonymous, with the token, /mcp still asks for OAuth", async () => {
  const port = await freePort();
  const server = startServer(["--transport", "streamable-http"], { AH_MCP_PORT: String(port), AH_MCP_TOKEN: TOKEN });
  try {
    // Upstream's mode has no /healthz to wait for: any answer from /mcp means it listens.
    await waitUntilUp(port, { path: "/mcp", ready: () => true, alive: () => server.child.exitCode === null });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    assert.ok(res.headers.get("www-authenticate"));
    assert.equal((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).status, 200);
  } finally {
    await server.stop();
  }
});

// Done-when 5 (spec section 5).
test("GET /healthz answers 200 with the body ok", async () => {
  const port = await freePort();
  const server = startServer(["--transport", "streamable-http", "--anonymous"], { AH_MCP_PORT: String(port) });
  try {
    await waitUntilUp(port, { alive: () => server.child.exitCode === null });
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    await server.stop();
  }
});
