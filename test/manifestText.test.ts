import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson } from "./helpers.ts";

const manifest = readJson("manifest.json");

test("manifest.json long_description does not tell the user to log in, and says the bundle starts without a login", () => {
  assert.doesNotMatch(manifest.long_description, /log (you )?in/i);
  assert.match(manifest.long_description, /without a login/i);
});
