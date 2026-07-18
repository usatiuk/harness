import type { Plugin } from "@harness/protocol";
import { executionServiceOf } from "@harness/execution";
import {
  ApplyPatchTool,
  CommandTool,
  EditTool,
  GlobTool,
  ReadFileTool,
  WriteTool,
} from "./tools.ts";

export * from "./tools.ts";
export * from "./apply-patch-parse.ts";

/**
 * Workspace tools: search files and run commands via the execution service, plus a file-edit roster
 * chosen by the model's `fileTools` profile. `text_editor` contributes no read/write/edit here —
 * the Anthropic plugin supplies the native editor, so the trio would only overlap it.
 */
export const workspacePlugin: Plugin = {
  id: "workspace",
  tools: (caps, ctx) => {
    const execution = executionServiceOf(ctx);
    const base = [new GlobTool(), new CommandTool(execution.shellKind)];
    switch (caps.fileTools) {
      case "apply_patch":
        return [...base, new ReadFileTool(), new WriteTool(), new ApplyPatchTool()];
      case "text_editor":
        return base;
      case "string_replace":
        return [...base, new ReadFileTool(), new WriteTool(), new EditTool()];
    }
  },
};
