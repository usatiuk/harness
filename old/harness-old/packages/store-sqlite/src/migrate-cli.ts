import { openSqliteHarnessStore } from "./index.ts";
import path from "node:path";

const dbPath = process.env.HARNESS_DB_PATH ?? path.join(process.env.INIT_CWD ?? process.cwd(), ".harness", "harness.sqlite");
const store = await openSqliteHarnessStore({ dbPath, migrate: true });
store.close();
console.log(`SQLite migrations applied to ${dbPath}`);
