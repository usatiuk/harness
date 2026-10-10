import { buildPayload, buildIdentity } from "../../../release/tools/build-payloads.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

if (process.env.HARNESS_RELEASE_BUILD === "1")
  throw new Error("Published desktop builds download server payloads; use desktop:release");

const output = fileURLToPath(new URL("../resources/", import.meta.url));
await buildPayload("server", output, await buildIdentity());
process.stderr.write(
  "Prepared complete development server payload; Node is shared through bootstrap.\n",
);
