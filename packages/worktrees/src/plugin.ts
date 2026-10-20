import { z } from "zod";
import { workspaceSelectionSchema as selection } from "./client-protocol.ts";
import {
  okResult,
  type ConversationId,
  type Plugin,
  type PluginDefinition,
  type WorkspaceSelection,
  type ToolContext,
} from "@harness/protocol";

export const worktreesConfigSchema = z.strictObject({
  directory: z.string().trim().min(1).optional(),
});

interface WorkspaceActions {
  workspaceOptions(id: ConversationId): Promise<unknown>;
  selectWorkspace(
    id: ConversationId,
    selection: WorkspaceSelection,
    deferred: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export class WorktreesDefinition implements PluginDefinition {
  readonly id = "worktrees";
  readonly configScope = "global" as const;
  readonly configSchema = worktreesConfigSchema;
  #actions: WorkspaceActions | undefined;

  bind(actions: WorkspaceActions): void {
    this.#actions = actions;
  }

  #runner(): WorkspaceActions {
    if (!this.#actions) throw new Error("Worktree conversation actions are not bound");
    return this.#actions;
  }

  create(): Plugin {
    return {
      id: this.id,
      tools: () => [
        {
          name: "worktree_list",
          essential: true,
          description:
            "List this conversation's original checkout, current directory, and Git worktrees.",
          input: { kind: "function", schema: z.strictObject({}) },
          execute: async (_, ctx) =>
            okResult(JSON.stringify(await this.#runner().workspaceOptions(ctx.conversationId))),
        },
        {
          name: "worktree_switch",
          essential: true,
          description:
            "Only when the user asks: switch this conversation to a new/existing Git worktree or back to its original checkout. With kind new, optional branch selects the new Git branch name; otherwise a readable name is generated. No files or history are copied. The switch is applied AFTER this entire tool batch, including parallel eval calls; all remaining calls in this batch still use the old directory. Stop background activities/subagents first.",
          input: {
            kind: "function",
            // Providers require an object at the schema root; retain the RPC union as
            // the runtime authority for variant-specific required and forbidden fields.
            schema: z
              .strictObject({
                kind: z.enum(["original", "new", "existing"]),
                branch: z
                  .string()
                  .min(1)
                  .optional()
                  .describe("Optional branch name for kind new only."),
                path: z
                  .string()
                  .min(1)
                  .optional()
                  .describe("Required worktree path for kind existing only."),
              })
              .pipe(selection),
          },
          execute: async (args: WorkspaceSelection, ctx: ToolContext) => {
            ctx.signal.throwIfAborted();
            await this.#runner().selectWorkspace(ctx.conversationId, args, true, ctx.signal);
            return okResult(
              "Workspace switch scheduled after this tool batch. Wait for the workspace-switch context before using the new directory.",
            );
          },
        },
      ],
    };
  }
}
