import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Exercise the actual built application's existing pre-window helper mode.
const result = spawnSync(resolve(process.argv[2]), ["--prepare-runtime", "{}"], {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
if (result.error) throw result.error;
assert.equal(result.status, 1, result.stderr);
assert.match(result.stderr, /Runtime preparation failed: missing field `home`/);
console.log("Packaged desktop handles runtime preparation before window setup");
