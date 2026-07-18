import { writeFileSync } from "node:fs";

writeFileSync(globalThis.process.argv[2], String(globalThis.process.pid));
globalThis.setInterval(() => {}, 1_000);
