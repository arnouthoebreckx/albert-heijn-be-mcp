import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnonymousSession } from "../src/auth/anonymous.ts";
import { Session } from "../src/auth/session.ts";
import { newToolContext, registerTools } from "../src/tools/index.ts";

/** The tools over an in-memory connection, on an anonymous token. Whatever fetch is then answers AH. */
export async function connect(): Promise<Client> {
  const session = new Session(join(mkdtempSync(join(tmpdir(), "ah-be-mcp-")), "tokens.json"));
  const ctx = newToolContext(session, { remote: true, hosted: false, anonymous: true, clients: new AnonymousSession() });
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** Calls a tool on its own connection; returns the structured result of a successful call. */
export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  return res.structuredContent;
}
