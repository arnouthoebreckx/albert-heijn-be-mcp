import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { read, readJson, root, stepScript, workflowJob } from "./helpers.ts";

// Milestone M7 (spec sections 6 and 8): the npm package goes to GitHub Packages, and the MCP Registry lists the
// .mcpb and the image. What only the release can run (the attestation, the registry login) is checked here as text.

const NAME = "albert-heijn-be-mcp";
const SCOPED_NAME = `@arnouthoebreckx/${NAME}`;
const VERSION = "1.2.0";
const MCP_NAME = "io.github.arnouthoebreckx/albert-heijn-be-mcp";
const LABEL = "io.modelcontextprotocol.server.name";
const GITHUB_PACKAGES = "https://npm.pkg.github.com";

const release = read(".github/workflows/release.yml");
const server = readJson("server.json");
const job = (name: string) => workflowJob(release, name);

/** The `permissions:` of one job, as written. */
function permissions(jobText: string): Record<string, string> {
  const lines = jobText.split("\n");
  const at = lines.findIndex((l) => l === "    permissions:");
  assert.notEqual(at, -1, "the job has no permissions");
  const granted: Record<string, string> = {};
  for (const l of lines.slice(at + 1)) {
    if (/^\s*#/.test(l)) continue;
    const m = /^ {6}(\S+): (\S+)\s*$/.exec(l);
    if (!m) break;
    granted[m[1]!] = m[2]!;
  }
  return granted;
}

// Done-when 2 (spec section 6).
test("npm pack names the scoped package at 1.2.0", () => {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
  assert.equal(packed.name, SCOPED_NAME);
  assert.equal(packed.version, VERSION);
  assert.equal(readJson("package.json").name, SCOPED_NAME);
});

// Done-when 4 (spec section 8, MCP Registry): the .mcpb and the image, no npm package. The .mcpb's hash only
// exists once the release has built the file, so the workflow writes it in (done-when 9) and the repository has none.
test("server.json lists the .mcpb and the image, and no npm package", () => {
  assert.deepEqual(server.packages.filter((p: { registryType: string }) => p.registryType === "npm"), []);
  assert.deepEqual(server.packages.map((p: { registryType: string }) => p.registryType).sort(), ["mcpb", "oci"]);
  const mcpb = server.packages.find((p: { registryType: string }) => p.registryType === "mcpb");
  assert.equal(mcpb.identifier, `https://github.com/arnouthoebreckx/${NAME}/releases/download/v${VERSION}/${NAME}.mcpb`);
  assert.deepEqual(mcpb.transport, { type: "stdio" });
  assert.equal(mcpb.fileSha256, undefined, "the hash is written in by the release, not committed");
  assert.equal(server.name, MCP_NAME);
});

test("server.json lists the image as a streamable HTTP package, published on 127.0.0.1 only", () => {
  const oci = server.packages.find((p: { registryType: string }) => p.registryType === "oci");
  assert.deepEqual(oci, {
    registryType: "oci",
    identifier: `ghcr.io/arnouthoebreckx/${NAME}:${VERSION}`,
    runtimeArguments: [{ type: "named", name: "--publish", value: "127.0.0.1:3000:3000" }],
    transport: { type: "streamable-http", url: "http://localhost:3000/mcp" },
  });
});

// Done-when 6 (spec section 8, image): the registry checks the label. The Dockerfile's last stage is the image.
test("the Dockerfile labels the image with the server name, in its last stage", () => {
  const lines = read("Dockerfile").split("\n").map((l) => l.trim());
  const lastStage = lines.slice(lines.map((l) => /^FROM /i.test(l)).lastIndexOf(true));
  assert.ok(lastStage.includes(`LABEL ${LABEL}="${MCP_NAME}"`), "no LABEL in the last stage");
});

test("CI's image job shows the label of the built image", () => {
  const image = workflowJob(read(".github/workflows/ci.yml"), "image");
  assert.ok(image.includes(`docker image inspect --format '{{ index .Config.Labels "${LABEL}" }}'`));
  assert.ok(image.indexOf("docker image inspect") > image.indexOf("docker build"));
});

// Done-when 7 (spec section 8, Flow): the tarball goes to GitHub Packages with GITHUB_TOKEN, and nothing goes to npmjs.
const OLD = [["registry", "npmjs", "org"].join("."), ["npm", "stage"].join(" "), "--" + "provenance", ["NPM", "TOKEN"].join("_")];

test("the release workflow publishes the tarball to GitHub Packages and names none of the npmjs flow", () => {
  for (const old of OLD) assert.ok(!release.includes(old), `release.yml still says ${old}`);
  const publish = job("release");
  assert.ok(publish.includes(`registry-url: ${GITHUB_PACKAGES}`));
  assert.ok(publish.includes("scope: '@arnouthoebreckx'"));
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(stepScript(publish, "Publish to GitHub Packages"), /npm publish albert-heijn-be-mcp\.tgz/);
  assert.equal(readJson("package.json").publishConfig.registry, GITHUB_PACKAGES);
});

test("each job of the release workflow has the permissions it needs and no more", () => {
  assert.deepEqual(permissions(job("release")), { contents: "write", packages: "write", "id-token": "write", attestations: "write" });
  assert.deepEqual(permissions(job("image")), { contents: "read", packages: "write", "id-token": "write", attestations: "write" });
  assert.deepEqual(permissions(job("registry")), { contents: "read", "id-token": "write" });
  assert.match(release, /^permissions:\n {2}contents: read\n/m, "the workflow's default is read-only");
});

test("a version already on GitHub Packages is skipped, a new one is published", () => {
  const script = stepScript(job("release"), "Publish to GitHub Packages");
  const run = (published: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ah-be-mcp-npm-"));
    const log = join(dir, "log");
    writeFileSync(join(dir, "npm"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = view ]; then [ -n "$STUB_VIEW" ] && echo "$STUB_VIEW" && exit 0; exit 1; fi\n`);
    chmodSync(join(dir, "npm"), 0o755);
    const res = spawnSync("bash", ["-ec", script], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, VERSION, STUB_VIEW: published }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    return readFileSync(log, "utf8");
  };
  const skipped = run(VERSION);
  assert.ok(skipped.includes(`view ${SCOPED_NAME}@${VERSION} version`), skipped);
  assert.ok(!skipped.includes("publish"), skipped);
  assert.ok(run("").includes("publish albert-heijn-be-mcp.tgz"));
});

// Done-when 8 (spec section 8, Flow): the tarball's build provenance, before it is published.
test("the release job attests the tarball's build provenance before it publishes it", () => {
  const publish = job("release");
  const attest = publish.indexOf("uses: actions/attest-build-provenance@v");
  assert.notEqual(attest, -1, "no attestation");
  assert.match(publish.slice(attest), /^[^\n]*@v\d+\n\s+with:\n\s+subject-path: albert-heijn-be-mcp\.tgz\n/);
  assert.ok(attest < publish.indexOf("- name: Publish to GitHub Packages"), "the attestation comes after the publish");
  assert.ok(attest > publish.indexOf("- name: Pack\n"), "the attestation comes before the tarball is packed");
  assert.equal(permissions(publish)["id-token"], "write");
  assert.equal(permissions(publish).attestations, "write");
});

// Done-when 9 (spec section 8, Flow and MCP Registry): its own job, after the .mcpb and the image are published.
test("the registry job waits for the release and the image and logs in with OIDC, without a stored token", () => {
  const registry = job("registry");
  assert.match(registry, /^ {4}needs: \[release, image\]$/m);
  assert.ok(!registry.includes("secrets."), "the registry job reads a secret");
  const hash = registry.indexOf("- name: Add the SHA-256 of the .mcpb to server.json");
  const login = registry.indexOf("./mcp-publisher login github-oidc");
  const publish = registry.indexOf("./mcp-publisher publish");
  assert.ok(hash !== -1 && login > hash && publish > login, "hash, then login, then publish");
  assert.ok(registry.indexOf("gh release download") !== -1 && registry.indexOf("gh release download") < hash);
});

test("the hash step writes the SHA-256 of the .mcpb into server.json, and only into the .mcpb package", () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-be-mcp-hash-"));
  writeFileSync(join(dir, `${NAME}.mcpb`), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256)));
  writeFileSync(join(dir, "server.json"), JSON.stringify(server));
  const res = spawnSync("bash", ["-ec", stepScript(job("registry"), "Add the SHA-256 of the .mcpb to server.json")], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const expected = execFileSync("sha256sum", [`${NAME}.mcpb`], { cwd: dir, encoding: "utf8" }).split(" ")[0];
  assert.match(expected!, /^[0-9a-f]{64}$/);
  const written = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
  const by = (type: string) => written.packages.find((p: { registryType: string }) => p.registryType === type);
  assert.equal(by("mcpb").fileSha256, expected);
  assert.equal(by("oci").fileSha256, undefined);
  assert.deepEqual({ ...written, packages: [] }, { ...server, packages: [] });
});

// Done-when 11 (spec section 6, README; section 8, Installing with npx).
test("the README's top shows Claude Desktop, docker run, LiteLLM, then npx with the two ~/.npmrc lines first", () => {
  const readme = read("README.md");
  const top = readme.split("\n---\n")[0]!;
  const at = (re: RegExp) => {
    const m = re.exec(top);
    assert.ok(m, `the top section lacks ${re}`);
    return m.index;
  };
  const [desktop, docker, litellm, npx] = [at(/\*\*Claude Desktop/), at(/\*\*docker run/), at(/\*\*LiteLLM/), at(/\*\*npx/)];
  assert.ok(desktop < docker && docker < litellm && litellm < npx, "the snippets are not in the order of the spec");
  const lines = [`@arnouthoebreckx:registry=${GITHUB_PACKAGES}`, "//npm.pkg.github.com/:_authToken=<a classic GitHub token with read:packages>"];
  const run = at(/npx -y @arnouthoebreckx\/albert-heijn-be-mcp --anonymous/);
  for (const line of lines) assert.ok(top.indexOf(line) > npx && top.indexOf(line) < run, `${line} is not between the npx heading and the command`);
  assert.match(top, /needs a token for every install, also of a public package/);
  assert.match(top, /image and the `\.mcpb` need no token/);
  assert.ok(top.includes(`${NAME}.mcpb`), "the .mcpb is not linked");
  assert.doesNotMatch(readme, /ghp_|github_pat_/);
});

// Done-when 12 (spec section 8): the grep of the issue, with its patterns built from parts so this file is not a hit.
test("nothing in the repository names the old package or npmjs", () => {
  const patterns = [OLD[0]!, OLD[1]!, ["trusted", "publish"].join(" "), `npx -y ${NAME}`];
  const res = spawnSync(
    "grep",
    ["-rn", ...patterns.flatMap((p) => ["-e", p]), ".", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude=package-lock.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(res.status, 1, res.stdout);
});
