import process from "node:process";
import { Buffer } from "node:buffer";
const { wire, code, hold, fragment } = JSON.parse(process.env.HARNESS_TEST_HELPER);
if (hold) {
  process.on("message", () => {});
  process.send("ready");
} else if (fragment) {
  const bytes = Buffer.from(wire);
  const character = bytes.indexOf("🦦");
  const split = character < 0 ? Math.floor(bytes.length / 2) : character + 1;
  process.stdout.write(bytes.subarray(0, split));
  process.once("message", () => {
    process.stdout.write(bytes.subarray(split), () => process.exit(code));
  });
  process.send("fragment");
} else process.stdout.write(wire, () => process.exit(code));
