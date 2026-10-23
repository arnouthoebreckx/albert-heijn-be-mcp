import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultTokensPath } from "./auth/tokens.ts";
import { SITE_NAMES, type SiteName } from "./site.ts";

const TRANSPORTS = ["stdio", "streamable-http"] as const;
type Transport = (typeof TRANSPORTS)[number];

export interface HttpOptions {
  /** Listen address. Default 127.0.0.1; use a reverse proxy for remote access. */
  host: string;
  port: number;
  /** Public URL of the server. */
  baseUrl: string;
  /** AH_MCP_TOKEN: the owner's OAuth login secret and signing key; serveHttp refuses to start without it. */
  secret?: string;
}

export interface Config {
  /** `login`: log in from the terminal and exit, instead of serving MCP. */
  command?: "login";
  transport: Transport;
  /** AH_SITE or --site: the AH site to talk to. */
  site: SiteName;
  /** AH_API_BASE_URL: replaces the site's API host, for tests. */
  apiBaseUrl?: string;
  /** AH_ANONYMOUS=true or --anonymous: no login; the server uses an anonymous token. */
  anonymous: boolean;
  /** Don't open a browser on login (e.g. on a server). */
  remote: boolean;
  /** Served over HTTP: users connect from apps elsewhere, possibly on a phone. */
  hosted: boolean;
  showVersion: boolean;
  showHelp: boolean;
  tokensPath: string;
  logFile?: string;
  http: HttpOptions;
}

export const USAGE = `Usage: albert-heijn-be-mcp [--site be|nl] [--anonymous] [--transport stdio|streamable-http] [--remote] [--version] [--help]
       albert-heijn-be-mcp login [--remote]

  login        log in to Albert Heijn from the terminal, save the tokens and exit
  --site       be (default) or nl: the Albert Heijn site (also AH_SITE)
  --anonymous  no login: use an anonymous token (also AH_ANONYMOUS=true)
  --transport  stdio (default) or streamable-http
  --remote     don't open a browser on login; ask for the code instead (also
               AH_REMOTE=true; always so with streamable-http)

Settings come from environment variables, also read from a .env file in the
working directory. See README.md.`;

/** Reads flags and environment variables. */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      site: { type: "string" },
      anonymous: { type: "boolean", default: false },
      transport: { type: "string", default: "stdio" },
      remote: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const [command, ...extra] = positionals;
  if ((command !== undefined && command !== "login") || extra.length > 0) {
    throw new Error(`unknown command "${positionals.join(" ")}" (the only command is login)`);
  }
  if (command === "login" && values.transport !== "stdio") throw new Error("login doesn't take --transport");
  const transport = values.transport as Transport;
  if (!TRANSPORTS.includes(transport)) {
    throw new Error(`unknown transport "${values.transport}" (use ${TRANSPORTS.join(" or ")})`);
  }
  const site = values.site ?? env.AH_SITE ?? "be";
  if (!SITE_NAMES.includes(site as SiteName)) throw new Error(`unknown site "${site}" (use ${SITE_NAMES.join(" or ")})`);
  const apiBaseUrl = env.AH_API_BASE_URL || undefined;
  if (apiBaseUrl && !URL.canParse(apiBaseUrl)) throw new Error(`AH_API_BASE_URL: "${apiBaseUrl}" is not a URL`);
  const port = envInt(env, "AH_MCP_PORT", 3000);
  const baseUrl = env.AH_MCP_BASE_URL || `http://localhost:${port}`;
  if (!URL.canParse(baseUrl)) throw new Error(`AH_MCP_BASE_URL: "${baseUrl}" is not a URL (e.g. https://albert-heijn-be-mcp.example.com)`);
  return {
    command,
    site: site as SiteName,
    apiBaseUrl,
    anonymous: values.anonymous || env.AH_ANONYMOUS === "true",
    transport,
    // Over HTTP the user is elsewhere, so a browser opened on this machine wouldn't reach them.
    remote: values.remote || env.AH_REMOTE === "true" || transport === "streamable-http",
    hosted: transport === "streamable-http",
    showVersion: values.version,
    showHelp: values.help,
    tokensPath: env.AH_TOKENS_PATH || defaultTokensPath(),
    logFile: env.AH_LOG_FILE || undefined,
    http: {
      host: env.AH_MCP_HOST || "127.0.0.1",
      port,
      baseUrl,
      secret: env.AH_MCP_TOKEN || undefined,
    },
  };
}

function envInt(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${key}: "${v}" is not a number`);
  return n;
}

/** Loads ./.env if present; existing variables take precedence. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
