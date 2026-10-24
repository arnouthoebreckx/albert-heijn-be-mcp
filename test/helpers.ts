import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function read(path: string): string {
  return readFileSync(`${root}${path}`, "utf8");
}

export function readJson(path: string): any {
  return JSON.parse(read(path));
}

/** The lines of one job in a workflow: from `  <job>:` to the next job at the same indent. */
export function workflowJob(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `no job ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The `run: |` script of the step with this name. */
export function stepScript(workflow: string, name: string): string {
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
