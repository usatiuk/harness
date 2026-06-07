import type { Plugin } from "@harness/protocol";
import { BashTool, EditTool, GlobTool, GrepTool, ReadFileTool, WriteTool } from "./tools.ts";

export * from "./tools.ts";

/** Workspace tools: read/search/write/edit files and run commands via `ctx.execution`. */
export const workspacePlugin: Plugin = {
  id: "workspace",
  tools: () => [
    new ReadFileTool(),
    new GlobTool(),
    new GrepTool(),
    new WriteTool(),
    new EditTool(),
    new BashTool(),
  ],
};
