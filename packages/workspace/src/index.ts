import type { Plugin } from "@harness/protocol";
import {
  executionFunctionTool,
  executionServiceOf,
  registerExecutionTool,
} from "@harness/execution";
import {
  CommandTool,
  EditTool,
  GlobTool,
  ReadFileTool,
  WriteTool,
  executionApplyPatchTool,
} from "./tools.ts";

export * from "./tools.ts";
export * from "./apply-patch-parse.ts";
export * from "./targets.ts";
export * from "./client-protocol.ts";
export * from "./process-activity.ts";

/** Workspace owns editing operations; input encoding is resolved independently by core. */
export const workspacePlugin: Plugin = {
  id: "workspace",
  tools: (caps, ctx) => {
    const execution = executionServiceOf(ctx);
    const managed = <T extends { name: string }>(tool: T): T => {
      registerExecutionTool(execution, tool.name);
      return tool;
    };
    const functionTool = (tool: Parameters<typeof executionFunctionTool>[1]) =>
      executionFunctionTool(execution, tool);
    const base = [managed(new GlobTool()), functionTool(new CommandTool(execution.shellKind))];
    const roster = () => {
      switch (caps.preferredEditTool) {
        case "patch":
          return [
            ...base,
            managed(new ReadFileTool()),
            functionTool(new WriteTool()),
            executionApplyPatchTool(execution),
          ];
        case "replace":
          return [
            ...base,
            managed(new ReadFileTool()),
            functionTool(new WriteTool()),
            functionTool(new EditTool()),
          ];
      }
    };
    return roster().map((tool) => Object.assign(tool, { essential: true }));
  },
};
