import { run } from "./index.ts";

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
