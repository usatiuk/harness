import { buildIdentity, buildPayload } from "./build-payloads.mjs";
import { writeFile, cp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const identity = await buildIdentity();
if (identity.target !== "linux-x64-glibc")
  throw new Error(
    "Build remote source payloads on Linux x64 glibc (WSL is supported), using the managed Node runtime",
  );
const output = join(root, "release/output", identity.target);
await buildPayload("server", join(output, "server"), identity);
// GNU tar makes archive identity stable across repeated source builds and keeps
// Unix executable modes and relative links in the complete npm dependency tree.
execFileSync(
  "tar",
  [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    join(output, "server.tar.gz"),
    "-C",
    output,
    "server",
  ],
  { windowsHide: true, stdio: "inherit" },
);
await cp(join(output, "server/harness-bootstrap"), join(output, "harness-bootstrap"));
async function describe(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: (await stat(path)).size, sha256: hash.digest("hex") };
}
await writeFile(
  join(output, "remote.json"),
  `${JSON.stringify(
    {
      formatVersion: 1,
      target: identity.target,
      productVersion: identity.productVersion,
      sourceCommit: identity.sourceCommit,
      nodeVersion: identity.nodeVersion,
      server: await describe(join(output, "server.tar.gz")),
      bootstrap: await describe(join(output, "harness-bootstrap")),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Remote source payload ready: ${output}\n`);
