import type { Plugin } from "@harness/protocol";
import {
  ApplyPatchTool,
  BashTool,
  EditTool,
  GlobTool,
  GrepTool,
  ReadFileTool,
  WriteTool,
} from "./tools.ts";

export * from "./tools.ts";
export * from "./apply-patch-parse.ts";

/** Workspace tools: read/search/write/patch files and run commands via `ctx.execution`. */
export const workspacePlugin: Plugin = {
  id: "workspace",
  tools: (caps) => [
    new ReadFileTool(),
    new GlobTool(),
    new GrepTool(),
    new WriteTool(),
    new BashTool(),
    caps.editFormat === "v4a" ? new ApplyPatchTool() : new EditTool(),
  ],
};
