import type { Plugin } from "@harness/protocol";
import { LocalExecutionProvider } from "./local.ts";

/** Contributes the local filesystem/child-process substrate as the host's execution backend. */
export const localExecutionPlugin: Plugin = {
  id: "local-execution",
  execution: () => new LocalExecutionProvider(),
};
