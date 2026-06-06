import { chmod, readFile } from "node:fs/promises";
import path from "node:path";

const packageDir = process.argv[2] ?? process.cwd();
const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const bin = manifest.bin;
if (!bin) {
  process.exit(0);
}
const targets = typeof bin === "string" ? [bin] : Object.values(bin);
await Promise.all(targets.map((target) => chmod(path.join(packageDir, target), 0o755)));
