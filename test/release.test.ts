import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanEnv } from "./serverProcess.ts";
import { read, readJson, root } from "./helpers.ts";

// Milestone M4 (spec sections 6, 8 and 9): what the household's tag `v1.0.0` will publish. The tag, the
// publishing and the checks against the published package and image are not done here.

const NAME = "albert-heijn-be-mcp";
const IMAGE = `ghcr.io/arnouthoebreckx/${NAME}`;
const UPSTREAM_LINE =
  "Unofficial. Not affiliated with Albert Heijn or Ahold Delhaize. Based on olekpuchka/albert-heijn-mcp v1.7.1, for ah.be, without a login.";

const release = read(".github/workflows/release.yml");

/** The lines of one job in a workflow: from `  <job>:` to the next job at the same indent. */
function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `no job ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The `run: |` script of the step with this name. */
function stepScript(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `no step ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  assert.notEqual(run, -1, `step ${name} has no run script`);
  const indent = lines[run + 1]!.search(/\S/);
  const script: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== "" && l.search(/\S/) < indent) break;
    script.push(l.slice(indent));
  }
  return script.join("\n");
}

// Done-when 1 (spec section 8, Added).
test("the release workflow has a job that pushes the image for both platforms with GITHUB_TOKEN", () => {
  const image = job(release, "image");
  assert.match(image, /docker\/setup-qemu-action@/);
  assert.match(image, /docker\/setup-buildx-action@/);
  assert.match(image, /docker\/build-push-action@/);
  assert.match(image, /platforms: linux\/amd64,linux\/arm64\b/);
  assert.match(image, /push: true/);
  assert.match(image, new RegExp(`${IMAGE.replaceAll(".", "\\.")}\\b`));
  assert.match(image, /registry: ghcr\.io/);
  assert.match(image, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(image, /packages: write/);
  assert.deepEqual([...release.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ["GITHUB_TOKEN"], "the workflow stores no other secret");
});

test("the image is tagged with the version of the release tag, and latest", () => {
  const image = job(release, "image");
  assert.match(image, /GITHUB_REF_NAME/);
  assert.match(image, new RegExp(`${IMAGE.replaceAll(".", "\\.")}:\\$\\{VERSION\\}`));
  assert.match(image, new RegExp(`${IMAGE.replaceAll(".", "\\.")}:latest`));
});

test("the image job attests build provenance", () => {
  const image = job(release, "image");
  assert.match(image, /actions\/attest-build-provenance@/);
  assert.match(image, /subject-digest: \$\{\{ steps\.\w+\.outputs\.digest \}\}/);
  assert.match(image, /push-to-registry: true/);
  assert.match(image, /attestations: write/);
  assert.match(image, /id-token: write/);
});

test("CI lints the workflows with actionlint", () => {
  assert.match(read(".github/workflows/ci.yml"), /actionlint/);
});

// Done-when 2 (spec sections 6 and 8).
test("the three versions are 1.0.0", () => {
  assert.equal(readJson("package.json").version, "1.0.0");
  assert.equal(readJson("server.json").version, "1.0.0");
  assert.equal(readJson("manifest.json").version, "1.0.0");
  assert.deepEqual(readJson("server.json").packages.map((p: { version: string }) => p.version), ["1.0.0"]);
});

test("the release workflow's version check passes for the tag v1.0.0, and fails for another tag", () => {
  const script = stepScript(release, "Check tag matches package.json");
  const check = (tag: string) => {
    const envFile = join(mkdtempSync(join(tmpdir(), "ah-be-mcp-")), "env");
    const res = spawnSync("bash", ["-ec", script], { cwd: root, env: { PATH: process.env.PATH ?? "", GITHUB_REF_NAME: tag, GITHUB_ENV: envFile }, encoding: "utf8" });
    return { status: res.status, out: res.stdout + res.stderr, envFile };
  };
  const ok = check("v1.0.0");
  assert.equal(ok.status, 0, ok.out);
  assert.equal(readFileSync(ok.envFile, "utf8"), "VERSION=1.0.0\n");
  assert.equal(check("v1.0.1").status, 1);
  assert.equal(check("1.0.0").status, 1);
});

// Done-when 3 (spec section 6).
test("the README starts with the unofficial notice and the four snippets, and upstream's README follows", () => {
  const readme = read("README.md");
  const [top = "", ...rest] = readme.split("\n---\n");
  assert.ok(readme.slice(0, 300).includes(UPSTREAM_LINE), "the notice is not at the top");
  assert.match(top, /npx -y albert-heijn-be-mcp --anonymous/);
  assert.match(top, /Claude Desktop/);
  assert.match(top, /"mcpServers"/);
  assert.match(top, new RegExp(`docker run .*${IMAGE.replaceAll(".", "\\.")}`));
  assert.match(top, /LiteLLM/);
  assert.match(top, /\/mcp\b/);
  const upstream = rest.join("\n---\n");
  assert.ok(upstream.startsWith("\n<p align=\"center\"><img src=\"assets/logo.png\""), "upstream's README does not follow the top section");
  assert.match(upstream, /\*\*Your Albert Heijn account, in your AI assistant\.\*\*/);
});

// Done-when 4 (spec section 9, item 1): npx on the packed tarball. The image run is CI's end-to-end test.
test("npx on the tarball from npm pack answers tools/list with the anonymous set", { timeout: 240_000 }, async () => {
  const snapshot: string[] = readJson("test/fixtures/tools-anonymous.snapshot.json").map((t: { name: string }) => t.name);
  const dir = mkdtempSync(join(tmpdir(), "ah-be-mcp-pack-"));
  const npm = { cwd: root, encoding: "utf8" as const };
  execFileSync("npm", ["run", "build"], npm);
  const tgz = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", dir], npm).trim();
  const { env, home } = cleanEnv({ npm_config_cache: process.env.npm_config_cache ?? join(homedir(), ".npm") });
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "--package", join(dir, tgz), NAME, "--anonymous"], cwd: home, env, stderr: "ignore" }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), snapshot);
  } finally {
    await client.close();
  }
});

// Done-when 5 (spec section 8, Version scheme).
test("NOTICE and the README name the upstream version", () => {
  assert.match(read("NOTICE"), /albert-heijn-mcp v1\.7\.1/);
  assert.ok(read("README.md").includes("olekpuchka/albert-heijn-mcp v1.7.1"));
});
