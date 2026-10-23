import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { read, readJson } from "./helpers.ts";

const NAME = "albert-heijn-be-mcp";
const MCP_NAME = "io.github.arnouthoebreckx/albert-heijn-be-mcp";
const REPO = "https://github.com/arnouthoebreckx/albert-heijn-be-mcp";

const pkg = readJson("package.json");
const server = readJson("server.json");
const manifest = readJson("manifest.json");

// Done-when 1 (spec section 6, identity test). The MCP Registry only accepts a reverse-DNS `name` in
// server.json, so there the name is the mcpName and the package name is `packages[].identifier`.
test("package.json, server.json and manifest.json agree on the name", () => {
  assert.equal(pkg.name, NAME);
  assert.equal(pkg.mcpName, MCP_NAME);
  assert.equal(server.name, pkg.mcpName);
  assert.deepEqual(
    server.packages.map((p: { identifier: string }) => p.identifier),
    [NAME],
  );
  assert.equal(manifest.name, NAME);
});

test("package.json, server.json and manifest.json have the same version", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(manifest.version, pkg.version);
  for (const p of server.packages) assert.equal(p.version, pkg.version);
});

// Done-when 2 (spec section 6).
test("package.json carries the new identity and keeps upstream's author as a contributor", () => {
  assert.deepEqual(pkg.bin, { [NAME]: "dist/index.js" });
  assert.equal(pkg.repository.url, `git+${REPO}.git`);
  assert.equal(pkg.homepage, `${REPO}#readme`);
  assert.equal(pkg.bugs.url, `${REPO}/issues`);
  assert.match(String(pkg.author), /Arnout Hoebreckx/);
  assert.ok(
    pkg.contributors.some((c: unknown) => /Olek Puchka/.test(typeof c === "string" ? c : JSON.stringify(c))),
    "upstream's author is not in contributors",
  );
  assert.deepEqual(pkg.files, ["dist", "assets/icon.png", `deploy/${NAME}.service`]);
  assert.ok(existsSync(new URL(`../deploy/${NAME}.service`, import.meta.url)));
});

// Done-when 3 (spec section 6): the other files carry the new name, and nothing of the old one is left.
test("server.json and manifest.json point to this repository", () => {
  assert.equal(server.repository.url, REPO);
  assert.equal(server.websiteUrl, `${REPO}#readme`);
  assert.match(server.icons[0].src, /arnouthoebreckx\/albert-heijn-be-mcp\//);
  assert.equal(manifest.repository.url, `${REPO}.git`);
  assert.equal(manifest.homepage, REPO);
  assert.equal(manifest.support, `${REPO}/issues`);
});

test("the release workflow's file names carry the new name", () => {
  const release = read(".github/workflows/release.yml");
  for (const file of [`${NAME}.tgz`, `${NAME}.mcpb`]) assert.ok(release.includes(file), `release.yml lacks ${file}`);
  assert.doesNotMatch(release, /albert-heijn-mcp/);
});

test("the deploy unit carries the new name", () => {
  const unit = read(`deploy/${NAME}.service`);
  assert.match(unit, new RegExp(`User=${NAME}`));
  assert.match(unit, new RegExp(`/usr/local/bin/${NAME} `));
  assert.doesNotMatch(unit, /albert-heijn-mcp/);
});

// Done-when 4 (spec section 1, Licence).
test("NOTICE names upstream, its version and that this package changed its files", () => {
  const notice = read("NOTICE");
  assert.match(notice, /olekpuchka\/albert-heijn-mcp/);
  assert.match(notice, /v1\.7\.1/);
  assert.match(notice, /changed/i);
});

test("LICENSE is still Apache-2.0", () => {
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(manifest.license, "Apache-2.0");
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
});
