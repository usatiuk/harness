import type { HarnessPlugins } from "@harness/client-features";
import {
  formatError,
  modelId,
  selectionId,
  type ConversationId,
  type PresetInfo,
  type ModelConfig,
  type ConversationConfig,
} from "@harness/protocol";
import type { HarnessClientService } from "@harness/client";
import type { Suggestion } from "./completion.ts";
import type { SandboxView } from "./sandbox-overlay.tsx";

/** The presets the given selection's model offers; empty when it has no preset axis. */
export const presetsFor = (service: HarnessClientService, model: ModelConfig): PresetInfo[] =>
  service.availableModels().find((m) => modelId(m) === modelId(model))?.presets ?? [];

/** What a slash command can act on. Kept narrow on purpose. */
export interface CommandContext {
  service: HarnessClientService;
  plugins: HarnessPlugins;
  conversationId: ConversationId;
  /** This conversation's workspace root. */
  cwd: string;
  /** The conversation's current selection (model + preset). */
  model: ModelConfig;
  /** The conversation's current fully resolved settings. */
  config: ConversationConfig;
  /** Append a local note line (command output / errors) to the transcript. */
  note: (text: string) => void;
  /** Clear the visible transcript. */
  clear: () => void;
  /** Switch conversation: an id resumes it directly; omitting it opens the picker. */
  resume: (id?: string) => void;
  /** Tear down and freshly activate this conversation. */
  reload: () => void;
  /** Open the model switcher overlay. */
  pickModel: () => void;
  /** Open the preset switcher overlay (for the current model). */
  pickPreset: () => void;
  /** Open the activities overlay. */
  showActivities: () => void;
  showQuestions: () => void;
  /** Open the sandbox overlay. */
  showSandbox: () => void;
  /** Imperative sandbox configuration and Docker lifecycle actions. */
  sandbox: SandboxView;
  /** Quit the app. */
  exit: () => void;
  manageHosts?: () => void;
  /** Open the earlier-message fork picker. */
  fork: () => void;
}

export interface Command {
  name: string;
  summary: string;
  run: (ctx: CommandContext, args: string[]) => void;
  /** Completion candidates for this command's arguments; filtered by the typed partial. */
  complete?: (ctx: CommandContext, args: string[]) => Suggestion[];
}

// Whitespace-split args suffice while commands take at most a bare id; defer a
// quote-aware tokenizer + schema until one needs structured arguments.
export const commands: Command[] = [
  {
    name: "docker",
    summary: "manage workspace environments: /docker [list [cursor]|stop <id>|remove <id>]",
    run: (ctx, args) => {
      const run = async () => {
        if (!args[0] || args[0] === "list") {
          const rows = await ctx.plugins.dockerEnvironments(20, args[1]);
          ctx.note(
            rows
              .map(
                (row) =>
                  `${row.id} · ${row.running ? "running" : "stopped"} · ${row.workspaceRoot ?? "Compose environment"}`,
              )
              .join("\n") || "no managed Docker environments",
          );
          if (rows.length === 20) ctx.note(`/docker list ${rows.at(-1)!.id} — next page`);
        } else if ((args[0] === "stop" || args[0] === "remove") && args[1]) {
          await ctx.plugins.controlDockerEnvironment(args[1], args[0]);
          ctx.note(
            args[0] === "stop"
              ? "environment stopped; state retained"
              : "environment removed; volumes retained",
          );
        } else ctx.note("usage: /docker [list [cursor]|stop <id>|remove <id>]");
      };
      void run().catch((error: unknown) => ctx.note(`docker: ${formatError(error)}`));
    },
  },

  {
    name: "worktree",
    summary:
      "list/switch worktrees: /worktree [new|original|use <path>|managed|delete [--force] <path>]",
    run: (ctx, args) => {
      const run = async () => {
        const action = args[0];
        if (!action || action === "list") {
          const options = await ctx.plugins.workspaceOptions(ctx.conversationId);
          if (!options) {
            ctx.note("This conversation is not in a Git repository");
            return;
          }
          ctx.note(
            options.worktrees
              .map(
                (tree) =>
                  `${tree.path === options.current ? "* " : "  "}${tree.branch ?? "detached"} · ${tree.path}`,
              )
              .join("\n"),
          );
        } else if (action === "new" || action === "original") {
          await ctx.plugins.switchWorkspace(ctx.conversationId, { kind: action });
          ctx.note("workspace switched");
        } else if (action === "use" && args.length > 1) {
          await ctx.plugins.switchWorkspace(ctx.conversationId, {
            kind: "existing",
            path: args.slice(1).join(" "),
          });
          ctx.note("workspace switched");
        } else if (action === "managed") {
          const rows = await ctx.plugins.managedWorktrees(20, args.slice(1).join(" ") || undefined);
          ctx.note(rows.map((tree) => tree.path).join("\n") || "no managed worktrees");
          if (rows.length === 20) ctx.note(`/worktree managed ${rows.at(-1)!.path} — next page`);
        } else if (action === "delete" && args.length > 1) {
          const force = args[1] === "--force";
          const path = args.slice(force ? 2 : 1).join(" ");
          if (!path) throw new Error("Specify the worktree path");
          await ctx.plugins.removeWorktree(path, force);
          ctx.note("worktree and Docker environment deleted; branch/history retained");
        } else
          ctx.note(
            "usage: /worktree [list|new|original|use <path>|managed [cursor]|delete [--force] <path>]",
          );
      };
      void run().catch((error: unknown) => ctx.note(`worktree: ${formatError(error)}`));
    },
  },

  {
    name: "hosts",
    summary: "open the agent command center",
    run: (ctx) =>
      ctx.manageHosts
        ? ctx.manageHosts()
        : ctx.note("Host management is available in the shared-server TUI"),
  },
  { name: "help", summary: "list commands", run: (ctx) => ctx.note(helpText()) },
  { name: "clear", summary: "clear the transcript", run: (ctx) => ctx.clear() },
  {
    name: "compact",
    summary: "compact conversation context",
    run: (ctx) => {
      void ctx.service.compact(ctx.conversationId).then(
        (result) => ctx.note(result === "compacted" ? "context compacted" : "nothing to compact"),
        (e: unknown) => ctx.note(`compaction failed: ${formatError(e)}`),
      );
    },
  },
  {
    name: "resume",
    summary: "switch conversation (/resume <id>, or /resume to pick)",
    run: (ctx, args) => ctx.resume(args[0]),
  },
  { name: "reload", summary: "reload the current conversation", run: (ctx) => ctx.reload() },
  {
    name: "fork",
    summary: "fork before a user message and edit its draft",
    run: (ctx) => ctx.fork(),
  },
  {
    name: "model",
    summary: "switch model (/model <id>, or /model to pick)",
    complete: (ctx) =>
      ctx.service.availableModels().map((m) => ({ value: modelId(m), label: modelId(m) })),
    run: (ctx, args) => {
      const id = args[0];
      if (!id) {
        ctx.pickModel();
        return;
      }
      // Resolve the bare id against the catalog so the provider comes along and an
      // unknown id is rejected up front. Accept either "model" or "provider/model".
      const match = ctx.service.availableModels().find((m) => m.model === id || modelId(m) === id);
      if (!match) {
        ctx.note(`unknown model: ${id}`);
        return;
      }
      const model = { provider: match.provider, model: match.model };
      void ctx.service.setModel(ctx.conversationId, model).then(
        () => ctx.note(`model → ${modelId(model)}`),
        (e: unknown) => ctx.note(`model switch failed: ${String(e)}`),
      );
    },
  },
  {
    name: "preset",
    summary: "set generation preset (/preset <value>, or /preset to pick)",
    complete: (ctx) =>
      presetsFor(ctx.service, ctx.model).map((e) => ({
        value: e.value,
        label: e.label ?? e.value,
      })),
    run: (ctx, args) => {
      const saved = presetsFor(ctx.service, ctx.model);
      const value = args[0];
      if (saved.length === 0) {
        ctx.note(`${ctx.model.model} has no preset options`);
        return;
      }
      if (!value) {
        ctx.pickPreset();
        return;
      }
      if (!saved.some((e) => e.value === value)) {
        ctx.note(`unknown preset: ${value} (try: ${saved.map((e) => e.value).join(", ")})`);
        return;
      }
      const model = { provider: ctx.model.provider, model: ctx.model.model, preset: value };
      void ctx.service.setPreset(ctx.conversationId, ctx.model, value).then(
        () => ctx.note(`preset → ${selectionId(model)}`),
        (e: unknown) => ctx.note(`preset switch failed: ${String(e)}`),
      );
    },
  },
  {
    name: "preset-default",
    summary: "restore the current model's provider-defined default preset",
    run: (ctx) => {
      const model = { provider: ctx.model.provider, model: ctx.model.model };
      void ctx.service.setPreset(ctx.conversationId, ctx.model, undefined).then(
        () => ctx.note(`preset → ${selectionId(model)}`),
        (e: unknown) => ctx.note(`preset switch failed: ${String(e)}`),
      );
    },
  },
  {
    name: "auto-approve",
    summary: "show or toggle model-based approval (/auto-approve [on|off])",
    complete: () => [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ],
    run: (ctx, args) => {
      const current = (ctx.config.plugins?.["auto-approval"] as
        { enabled?: boolean; model?: ModelConfig } | undefined) ?? { enabled: false };
      const value = args[0];
      if (!value) {
        const reviewer = current.model
          ? `${selectionId(current.model)} (configured reviewer)`
          : `${selectionId(ctx.model)} (turn model)`;
        ctx.note(`auto-approval ${current.enabled ? "on" : "off"} · reviewer ${reviewer}`);
        return;
      }
      if (value !== "on" && value !== "off") {
        ctx.note("usage: /auto-approve [on|off]");
        return;
      }
      const enabled = value === "on";
      void ctx.service
        .setPluginConfig(ctx.conversationId, "auto-approval", { enabled }, { saveGlobal: true })
        .then(
          () => ctx.note(`auto-approval → ${value}`),
          (e: unknown) => ctx.note(`auto-approval change failed: ${String(e)}`),
        );
    },
  },
  { name: "questions", summary: "answer pending questions", run: (ctx) => ctx.showQuestions() },
  { name: "activities", summary: "show running activities", run: (ctx) => ctx.showActivities() },
  {
    name: "sandbox",
    summary:
      "manage execution sandbox (/sandbox [none|native|docker|write on|off|network on|off|rebuild|stop])",
    run: (ctx, args) => {
      switch (args[0]) {
        case undefined:
          return ctx.showSandbox();
        case "none":
        case "native":
        case "docker":
          return ctx.sandbox.setBackend(args[0]);
        case "write":
          if (args[1] === "on" || args[1] === "off")
            return ctx.sandbox.setWorkspaceWrite(args[1] === "on");
          return ctx.note("usage: /sandbox write on|off");
        case "network":
          if (args[1] === "on" || args[1] === "off")
            return ctx.sandbox.setNetwork(args[1] === "on");
          return ctx.note("usage: /sandbox network on|off");
        case "rebuild":
          return ctx.sandbox.rebuild();
        case "stop":
          return ctx.sandbox.stop();
        default:
          return ctx.note(
            `unknown sandbox action: ${args[0]} (none|native|docker|write|network|rebuild|stop)`,
          );
      }
    },
  },
  { name: "exit", summary: "quit", run: (ctx) => ctx.exit() },
  {
    name: "tick",
    summary: "send a demo external-input turn",
    run: (ctx) => {
      setTimeout(() => void ctx.service.send(ctx.conversationId, "(external tick)"), 500);
    },
  },
];

export const byName = new Map(commands.map((c) => [c.name, c]));

/** Dispatch a `/command [args…]` line. Returns false if the command is unknown. */
export function runCommand(line: string, ctx: CommandContext): boolean {
  const [name, ...args] = line.slice(1).trim().split(/\s+/);
  const command = byName.get(name ?? "");
  if (!command) return false;
  command.run(ctx, args);
  return true;
}

const helpText = (): string => commands.map((c) => `  /${c.name} — ${c.summary}`).join("\n");
