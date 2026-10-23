import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { read, readJson, root } from "./helpers.ts";

/** What `make <target>` would run, without running it. */
function dryRun(target: string): string {
  return execFileSync("make", ["-n", target], { cwd: root, encoding: "utf8" });
}

// Done-when 5 (spec section 7, One gate).
test("make setup installs without running install scripts", () => {
  assert.match(dryRun("setup"), /npm ci --ignore-scripts/);
});

test("make check runs the type check, the build, node --test and mcpb validate", () => {
  const plan = dryRun("check");
  for (const step of ["npm run lint", "npm run build", "npm test", "mcpb@2.1.2 validate manifest.json"]) {
    assert.ok(plan.includes(step), `make check does not run ${step}`);
  }
  const { scripts } = readJson("package.json");
  assert.equal(scripts.lint, "tsc --noEmit");
  assert.match(scripts.build, /^tsc -p tsconfig\.build\.json/);
  assert.match(scripts.test, /^node --test /);
});

test("make audit is npm audit --omit=dev --audit-level=high", () => {
  assert.match(dryRun("audit"), /npm audit --omit=dev --audit-level=high/);
});

// Done-when 6 (spec section 7, One gate).
test("AGENTS.md and CLAUDE.md name the npm commands, and CLAUDE.md points to AGENTS.md", () => {
  const agents = read("AGENTS.md");
  for (const cmd of ["make setup", "make check", "make audit", "npm ci --ignore-scripts", "node --test"]) {
    assert.ok(agents.includes(cmd), `AGENTS.md lacks ${cmd}`);
  }
  assert.match(read("CLAUDE.md"), /AGENTS\.md/);
});

// Done-when 7 (spec section 7, One gate): CI runs the same gate.
test("CI runs make check and make audit", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /run: make check/);
  assert.match(ci, /run: make audit/);
});
