#!/usr/bin/env node
// albert-heijn-be-mcp: a Model Context Protocol server for the Albert Heijn supermarket API.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnonymousSession } from "./auth/anonymous.ts";
import { Session } from "./auth/session.ts";
import { loadConfig, loadDotEnv, USAGE } from "./config.ts";
import { instructions } from "./instructions.ts";
import { closeLog, log, logToFile } from "./log.ts";
import { runLogin } from "./loginCommand.ts";
import { serveHttp } from "./server/http.ts";
import { configureSite } from "./site.ts";
import { newToolContext, registerTools } from "./tools/index.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Shown by clients that display server icons. */
const ICON = {
  src: `data:image/png;base64,${readFileSync(new URL("../assets/icon.png", import.meta.url)).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["128x128"],
};

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig(process.argv.slice(2));
  configureSite(cfg.site, cfg.apiBaseUrl);
  if (cfg.showHelp) {
    console.log(USAGE);
    return;
  }
  if (cfg.showVersion) {
    console.log(`albert-heijn-be-mcp ${version}`);
    return;
  }
  if (cfg.command === "login") {
    try {
      await runLogin(new Session(cfg.tokensPath), cfg.remote);
    } catch (err) {
      console.error(`Login failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (cfg.logFile) await logToFile(cfg.logFile);
  log.info("albert-heijn-be-mcp", { version });

  const ctx = newToolContext(new Session(cfg.tokensPath), {
    remote: cfg.remote,
    hosted: cfg.hosted,
    clients: cfg.anonymous ? new AnonymousSession() : undefined,
  });
  const newServer = () => {
    const server = new McpServer({ name: "albert-heijn-be-mcp", title: "Albert Heijn", version, icons: [ICON] }, { instructions: instructions() });
    registerTools(server, ctx);
    return server;
  };

  if (cfg.transport === "stdio") {
    log.info("starting server", { transport: "stdio" });
    await newServer().connect(new StdioServerTransport());
    // The client is gone or stops this server: close a login window first, so it and its temporary
    // profile aren't left behind.
    process.stdin.once("end", () => void ctx.browserLogin.cancel());
    for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
      process.once(signal, () => {
        setTimeout(() => exit(status), 10_000).unref();
        void ctx.browserLogin.cancel().then(() => exit(status));
      });
    }
    return;
  }

  const httpServer = await serveHttp(newServer, cfg.http);
  const shutdown = () => {
    log.info("shutting down");
    httpServer.close(() => exit(0));
    setTimeout(() => exit(0), 5000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Exits once the log file has the last lines. */
function exit(code: number): void {
  void closeLog().then(() => process.exit(code));
}

// Node would print these in full, possibly quoting AH's responses; log them safely instead.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    log.error(event, { err });
    exit(1);
  });
}

main().catch((err) => {
  log.error("fatal", { err });
  exit(1);
});
