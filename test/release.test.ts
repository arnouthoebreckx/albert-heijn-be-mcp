import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanEnv } from "./serverProcess.ts";
import { read, readJson, root, stepScript, workflowJob as job } from "./helpers.ts";

// Milestone M4 (spec sections 6, 8 and 9): what the household's tag will publish. The tag, the publishing
// and the checks against the published package and image are not done here. M7 moves the version to 1.1.1,
// the package to GitHub Packages and the registry entry to the .mcpb and the image; M8 moves it to 1.2.0, M9 to 1.3.0.

const VERSION = "1.3.0";

const NAME = "albert-heijn-be-mcp";
const IMAGE = `ghcr.io/arnouthoebreckx/${NAME}`;
const UPSTREAM_LINE =
  "Unofficial. Not affiliated with Albert Heijn or Ahold Delhaize. Based on olekpuchka/albert-heijn-mcp v1.7.1, for ah.be, without a login.";

const release = read(".github/workflows/release.yml");

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
  assert.deepEqual([...new Set([...release.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))], ["GITHUB_TOKEN"], "the workflow stores no other secret");
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

// Done-when 2 (spec sections 6 and 8); M6 done-when 5 moves it to 1.1.0, M7 done-when 1 to 1.1.1, M8 done-when 14 to 1.2.0, M9 done-when 6 to 1.3.0. Since M7
// server.json lists no npm package, so none of its packages has a `version`: the .mcpb URL and the image tag carry it.
test(`the three versions, and the root of package-lock.json, are ${VERSION}`, () => {
  assert.equal(readJson("package.json").version, VERSION);
  assert.equal(readJson("server.json").version, VERSION);
  assert.equal(readJson("manifest.json").version, VERSION);
  assert.deepEqual(readJson("server.json").packages.filter((p: { version?: string }) => p.version !== undefined), []);
  assert.equal(readJson("package-lock.json").version, VERSION);
  assert.equal(readJson("package-lock.json").packages[""].version, VERSION);
});

test(`the release workflow's version check passes for the tag v${VERSION}, and fails for another tag`, () => {
  const script = stepScript(release, "Check tag matches package.json");
  const check = (tag: string) => {
    const envFile = join(mkdtempSync(join(tmpdir(), "ah-be-mcp-")), "env");
    const res = spawnSync("bash", ["-ec", script], { cwd: root, env: { PATH: process.env.PATH ?? "", GITHUB_REF_NAME: tag, GITHUB_ENV: envFile }, encoding: "utf8" });
    return { status: res.status, out: res.stdout + res.stderr, envFile };
  };
  const ok = check(`v${VERSION}`);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(readFileSync(ok.envFile, "utf8"), `VERSION=${VERSION}\n`);
  assert.equal(check("v1.0.0").status, 1);
  assert.equal(check("v1.1.0").status, 1);
  assert.equal(check(VERSION).status, 1);
});

// Done-when 3 (spec section 6).
test("the README starts with the unofficial notice and the four snippets, and upstream's README follows", () => {
  const readme = read("README.md");
  const [top = "", ...rest] = readme.split("\n---\n");
  assert.ok(readme.slice(0, 300).includes(UPSTREAM_LINE), "the notice is not at the top");
  assert.match(top, /npx -y @arnouthoebreckx\/albert-heijn-be-mcp --anonymous/);
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
// M7 done-when 3: the tarball is the scoped package; the binary is still `albert-heijn-be-mcp`.
test("npx on the tarball from npm pack answers tools/list with the anonymous set", { timeout: 240_000 }, async () => {
  const snapshot: string[] = readJson("test/fixtures/tools-anonymous.snapshot.json").map((t: { name: string }) => t.name);
  const dir = mkdtempSync(join(tmpdir(), "ah-be-mcp-pack-"));
  const npm = { cwd: root, encoding: "utf8" as const };
  execFileSync("npm", ["run", "build"], npm);
  const tgz = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", dir], npm).trim();
  assert.equal(tgz, `arnouthoebreckx-${NAME}-${VERSION}.tgz`, "the tarball is not the scoped package");
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

// M6 done-when 6 and 7: the image job. Its scripts run in a copy of the three version files at `version`.
// M7 done-when 10: server.json's packages have no version of their own; the .mcpb URL and the image tag carry it,
// and `mcpbTag` and `ociTag` let a test put a wrong one there.
const CHECK = "Check tag matches package.json";
const TAGS = "Tag the image from the release tag";

const MCPB_URL = (tag: string) => `https://github.com/arnouthoebreckx/${NAME}/releases/download/${tag}/${NAME}.mcpb`;

function runInCopy(
  script: string,
  tag: string,
  versions: { package?: string; server?: string; manifest?: string; mcpbTag?: string; ociTag?: string },
) {
  const dir = mkdtempSync(join(tmpdir(), "ah-be-mcp-wf-"));
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const manifest = readJson("manifest.json");
  const version = versions.package ?? pkg.version;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version }));
  server.version = versions.server ?? version;
  for (const p of server.packages) {
    if (p.registryType === "mcpb") p.identifier = MCPB_URL(versions.mcpbTag ?? `v${version}`);
    if (p.registryType === "oci") p.identifier = `${IMAGE}:${versions.ociTag ?? version}`;
  }
  writeFileSync(join(dir, "server.json"), JSON.stringify(server));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version: versions.manifest ?? version }));
  const env = join(dir, "env");
  const out = join(dir, "output");
  const res = spawnSync("bash", ["-ec", script], { cwd: dir, env: { PATH: process.env.PATH ?? "", GITHUB_REF_NAME: tag, GITHUB_ENV: env, GITHUB_OUTPUT: out }, encoding: "utf8" });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return { status: res.status, log: res.stdout + res.stderr, env: read(env), output: read(out) };
}

// Steps that run before the image is pushed: the check, then the tags. The runner hands VERSION from one step to the next through GITHUB_ENV.
const beforePush = (): string =>
  `${stepScript(job(release, "image"), CHECK)}\nset -a; . "$GITHUB_ENV"; set +a\n${stepScript(job(release, "image"), TAGS)}`;

test("the image job checks package.json, server.json and manifest.json against the tag before it pushes", () => {
  const image = job(release, "image");
  assert.ok(image.indexOf(`- name: ${CHECK}`) !== -1 && image.indexOf(`- name: ${CHECK}`) < image.indexOf("docker/build-push-action@"));
  assert.equal(stepScript(image, CHECK), stepScript(job(release, "release"), CHECK), "the two jobs check differently");
  assert.equal(stepScript(image, CHECK), stepScript(job(release, "registry"), CHECK), "the registry job checks differently");
  const ok = runInCopy(beforePush(), `v${VERSION}`, {});
  assert.equal(ok.status, 0, ok.log);
  for (const bad of [{ server: "1.0.0" }, { manifest: "1.0.0" }, { package: "1.0.0" }]) {
    const res = runInCopy(beforePush(), `v${VERSION}`, bad);
    assert.equal(res.status, 1, `${JSON.stringify(bad)}: ${res.log}`);
    assert.equal(res.output, "", `${JSON.stringify(bad)}: the tags were written`);
  }
});

test("latest moves only for a tag of the form vMAJOR.MINOR.PATCH", () => {
  const stable = runInCopy(beforePush(), `v${VERSION}`, {});
  assert.match(stable.output, new RegExp(`tags=.*${IMAGE}:${VERSION.replaceAll(".", "\\.")}\\b`));
  assert.match(stable.output, new RegExp(`${IMAGE}:latest`));
  for (const version of [`${VERSION}-rc.1`, `${VERSION}+build.5`]) {
    const pre = runInCopy(beforePush(), `v${version}`, { package: version, server: version, manifest: version });
    assert.equal(pre.status, 0, pre.log);
    assert.ok(pre.output.includes(`${IMAGE}:${version}`), pre.output);
    assert.ok(!pre.output.includes("latest"), `${version} moves latest: ${pre.output}`);
  }
});

// M6 done-when 8: upstream's unit, with the old user and path, is gone.
test("deploy/ holds only the unit of this package", () => {
  assert.deepEqual(readdirSync(join(root, "deploy")), [`${NAME}.service`]);
});

// M6 done-when 9: an install from the MCP Registry or the .mcpb runs without a login. Since M7 (spec section 8)
// the registry lists the .mcpb, whose manifest passes --anonymous, and the image, whose CMD does: no package
// of server.json has arguments or environment variables of its own.
test("server.json and manifest.json start the server with --anonymous", () => {
  const server = readJson("server.json");
  for (const p of server.packages) {
    assert.equal(p.packageArguments, undefined, p.registryType);
    assert.equal(p.environmentVariables, undefined, p.registryType);
  }
  assert.deepEqual(readJson("manifest.json").server.mcp_config.args, ["${__dirname}/dist/index.js", "--anonymous"]);
});

// M7 done-when 10 (spec section 8; M6 done-when 6): the check also holds the .mcpb URL and the image tag to the release tag.
test("the version check fails when the oci tag or the .mcpb URL of server.json is another version", () => {
  const check = stepScript(release, CHECK);
  assert.equal(runInCopy(check, `v${VERSION}`, {}).status, 0);
  const wrongOci = runInCopy(check, `v${VERSION}`, { ociTag: "1.1.0" });
  assert.equal(wrongOci.status, 1, wrongOci.log);
  assert.match(wrongOci.log, /oci|image/i);
  const wrongUrl = runInCopy(check, `v${VERSION}`, { mcpbTag: "v1.1.0" });
  assert.equal(wrongUrl.status, 1, wrongUrl.log);
  assert.match(wrongUrl.log, /mcpb/i);
});
