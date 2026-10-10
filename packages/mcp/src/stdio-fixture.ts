import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { fixtureServer } from "./testing-fixture.ts";
import { appendFile } from "node:fs/promises";
if (process.env["FIXTURE_PID_FILE"])
  await appendFile(process.env["FIXTURE_PID_FILE"], `${process.pid}\n`);
serveStdio(() => fixtureServer());
