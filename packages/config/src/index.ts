import { homedir } from "node:os";
import { join } from "node:path";

export * from "./settings.ts";
export * from "./resolve.ts";
export * from "./reader.ts";

/** The default harness home directory: `~/.harness` (global settings, and later the db). */
export const defaultHome = (): string => join(homedir(), ".harness");
