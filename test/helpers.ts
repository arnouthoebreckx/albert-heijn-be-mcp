import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function read(path: string): string {
  return readFileSync(`${root}${path}`, "utf8");
}

export function readJson(path: string): any {
  return JSON.parse(read(path));
}
