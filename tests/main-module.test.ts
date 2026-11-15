import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/shared/main-module.js";

test("isMainModule matches the entry point path", () => {
  const entry = resolve("some/dir/daemon.js");
  assert.equal(isMainModule(pathToFileURL(entry).href, entry), true);
});

test("isMainModule rejects a different module", () => {
  const entry = resolve("some/dir/daemon.js");
  const other = resolve("some/dir/doctor.js");
  assert.equal(isMainModule(pathToFileURL(other).href, entry), false);
});

test("isMainModule rejects a missing argv entry", () => {
  const entry = resolve("some/dir/daemon.js");
  assert.equal(isMainModule(pathToFileURL(entry).href, undefined), false);
});
