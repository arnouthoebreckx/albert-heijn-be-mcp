import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./helpers.ts";

// What the image, CI, Dependabot and the README must say. The image itself is run by CI (test/e2e.test.ts).

const dockerfile = () => read("Dockerfile").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const instructions = (name: string) => dockerfile().filter((l) => l.toUpperCase().startsWith(`${name} `));

// Done-when 7 (spec section 7, Image).
test("the Dockerfile is multi-stage, on node:24-slim or distroless", () => {
  const froms = instructions("FROM");
  assert.ok(froms.length >= 2, "more than one stage");
  assert.match(froms.at(-1)!, /^FROM (node:24-slim|gcr\.io\/distroless\/nodejs24-debian\d+)\b/i);
});

test("the image runs as a user that is not root", () => {
  const users = instructions("USER");
  assert.ok(users.length > 0, "no USER");
  assert.doesNotMatch(users.at(-1)!, /^USER (root|0)\b/i);
});

test("the image has a HEALTHCHECK on /healthz", () => {
  const health = instructions("HEALTHCHECK");
  assert.equal(health.length, 1);
  assert.match(dockerfile().join("\n"), /HEALTHCHECK[\s\S]*\/healthz/);
});

test("the image defaults: AH_SITE=be, --anonymous, streamable HTTP, AH_MCP_HOST=0.0.0.0", () => {
  const env = instructions("ENV").join(" ");
  assert.match(env, /\bAH_SITE=be\b/);
  assert.match(env, /\bAH_MCP_HOST=0\.0\.0\.0\b/);
  const cmd = [...instructions("CMD"), ...instructions("ENTRYPOINT")].join(" ");
  assert.match(cmd, /--anonymous/);
  assert.match(cmd, /streamable-http/);
});

test("the image holds no secrets", () => {
  const lines = dockerfile();
  for (const l of lines.filter((l) => /^(ENV|ARG) /i.test(l))) assert.doesNotMatch(l, /TOKEN|SECRET|PASSWORD|API_?KEY/i, l);
  for (const l of lines.filter((l) => /^(COPY|ADD) /i.test(l))) assert.doesNotMatch(l, /\.env|tokens\.json/, l);
  const ignored = read(".dockerignore").split("\n");
  for (const f of [".env", "tokens.json", ".git", "node_modules"]) assert.ok(ignored.includes(f), `.dockerignore lacks ${f}`);
});

test("the end-to-end test runs the image read-only", () => {
  assert.match(read("test/e2e.test.ts"), /"--read-only"/);
});

// Done-when 8 (spec section 7, CI).
test("CI builds the image on every pull request and runs the end-to-end test against it", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^on:[\s\S]*^\s+pull_request:/m);
  assert.match(ci, /run: docker build\b/);
  assert.match(ci, /AH_E2E_IMAGE=\S+ node --test test\/e2e\.test\.ts/);
});

// Done-when 9 (spec section 7, Dependabot).
test("Dependabot covers the Docker base image and upstream's ecosystems", () => {
  const dependabot = read(".github/dependabot.yml");
  for (const ecosystem of ["npm", "github-actions", "docker"]) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}\\b`));
  }
});

// Done-when 10 (spec section 5).
test("the README says to expose the HTTP mode only on a private network behind a gateway", () => {
  assert.match(read("README.md"), /only on a private network behind a gateway/i);
});
