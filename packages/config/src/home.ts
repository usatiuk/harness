import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The default harness home directory: `~/.harness` (global settings, and later the db). */
export const defaultHome = (): string =>
  process.env.HARNESS_HOME ? resolve(process.env.HARNESS_HOME) : join(homedir(), ".harness");
