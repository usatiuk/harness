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

/**
 * Workspace tools: search files and run commands via the execution service, plus a file-edit roster
 * chosen by the model's `fileTools` profile. `text_editor` contributes no read/write/edit here —
 * the Anthropic plugin supplies its Harness-executed editor, so the trio would only overlap it.
 */
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
    switch (caps.fileTools) {
      case "apply_patch":
        return [
          ...base,
          managed(new ReadFileTool()),
          functionTool(new WriteTool()),
          executionApplyPatchTool(execution),
        ];
      case "text_editor":
        return base;
      case "string_replace":
        return [
          ...base,
          managed(new ReadFileTool()),
          functionTool(new WriteTool()),
          functionTool(new EditTool()),
        ];
    }
  },
};
