import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Call, route } from "./fakeAh.ts";

export interface FakeAhServer {
  /** For a server process on this machine. */
  url: string;
  /** For a container: the same server, reached through the host. */
  containerUrl: string;
  port: number;
  /** The requests it got, in order. */
  calls: Call[];
  close(): Promise<void>;
}

/**
 * The fake AH of fakeAh.ts as a real HTTP server, for tests that run the MCP server as a process or in
 * a container (AH_API_BASE_URL points it here). Listens on `host`; "0.0.0.0" so a container can reach it.
 */
export async function startFakeAh(host = "127.0.0.1"): Promise<FakeAhServer> {
  const calls: Call[] = [];
  let tokens = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const call: Call = {
      method: req.method ?? "GET",
      url: new URL(req.url ?? "/", "http://fake-ah"),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const reply = route(call, () => ++tokens);
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    containerUrl: `http://host.docker.internal:${port}`,
    port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
