import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HttpOptions } from "../config.ts";
import { log } from "../log.ts";
import { OAuth } from "./oauth.ts";
import { isLoopbackHost, readBody } from "./request.ts";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MIN_SECRET_LENGTH = 32;

/** Reports whether url's host is localhost or loopback; an unparsable url is not. */
function isLocalUrl(url: string): boolean {
  return URL.canParse(url) && isLoopbackHost(new URL(url).hostname);
}

/** Serves MCP at /mcp, stateless: each request gets a new server. Resolves once listening. */
export async function serveHttp(newServer: () => McpServer, opts: HttpOptions): Promise<Server> {
  // Anyone who reaches the server acts as the logged-in AH account, and a
  // reverse proxy can make a loopback listener public without the server knowing.
  const { secret } = opts;
  // Long enough not to be guessed: anyone can register an OAuth client and test guesses offline against its signed ID.
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `the HTTP transport needs AH_MCP_TOKEN of at least ${MIN_SECRET_LENGTH} characters; generate one with: openssl rand -hex 32`,
    );
  }
  if (new URL(opts.baseUrl).protocol !== "https:" && !isLocalUrl(opts.baseUrl)) {
    log.warn("AH_MCP_BASE_URL is not https: the login page would send AH_MCP_TOKEN unencrypted", { base_url: opts.baseUrl });
  }

  // DNS-rebinding protection for local-only setups. When the server is
  // reachable under another name (reverse proxy, or listening on a LAN
  // address), the Host header differs, so the check is off.
  const local = isLocalUrl(opts.baseUrl) && isLoopbackHost(opts.host);
  // Clients omit the port for port 80; a local proxy may listen on another port (the base URL's).
  const allowedHosts = local
    ? new Set([
        ...["localhost", "127.0.0.1", "[::1]"].flatMap((h) => (opts.port === 80 ? [h, `${h}:80`] : [`${h}:${opts.port}`])),
        new URL(opts.baseUrl).host,
      ])
    : undefined;

  // Clients log in with OAuth; MCP requests carry the access token they get.
  const oauth = new OAuth(opts.baseUrl, MCP_PATH, secret);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Checked here rather than in the MCP transport, so it covers the OAuth routes too.
    if (allowedHosts && !allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await oauth.handle(req, res, url)) return;
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end("Not Found");
      return;
    }
    const challenge = oauth.authenticate(req);
    if (challenge) {
      res.writeHead(401, { "WWW-Authenticate": challenge }).end("Unauthorized");
      return;
    }
    const raw = req.method === "POST" ? await readBody(req, MAX_BODY_BYTES) : "";
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      // A rejection here would reach the unhandledRejection handler, which exits.
      transport.close().catch((err: unknown) => log.warn("closing MCP transport failed", { err }));
      server.close().catch((err: unknown) => log.warn("closing MCP server failed", { err }));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error("HTTP request failed", { err });
      if (!res.headersSent) res.writeHead(400).end("Bad Request");
    });
  });
  httpServer.headersTimeout = 10_000;
  // Receiving a request, not answering it: a slow body can't hold a connection for Node's default 5 minutes.
  httpServer.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, resolve);
  });
  log.info("starting server", {
    transport: "streamable-http",
    addr: `${opts.host}:${opts.port}${MCP_PATH}`,
    base_url: opts.baseUrl,
  });
  return httpServer;
}
