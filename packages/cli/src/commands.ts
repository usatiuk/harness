import {
  modelId,
  selectionId,
  type ConversationId,
  type EffortInfo,
  type ModelConfig,
} from "@harness/protocol";
import type { HarnessService } from "@harness/service";

/** The effort levels the given selection's model offers; empty when it has no effort axis. */
export const effortsFor = (service: HarnessService, model: ModelConfig): EffortInfo[] =>
  service.availableModels().find((m) => modelId(m) === modelId(model))?.efforts ?? [];

/** What a slash command can act on. Kept narrow on purpose. */
export interface CommandContext {
  service: HarnessService;
  conversationId: ConversationId;
  /** The conversation's current selection (model + effort). */
  model: ModelConfig;
  /** Append a local note line (command output / errors) to the transcript. */
  note: (text: string) => void;
  /** Clear the visible transcript. */
  clear: () => void;
  /** Switch conversation: an id resumes it directly; omitting it opens the picker. */
  resume: (id?: string) => void;
  /** Open the model switcher overlay. */
  pickModel: () => void;
  /** Open the effort switcher overlay (for the current model). */
  pickEffort: () => void;
  /** Open the activities overlay. */
  showActivities: () => void;
  /** Quit the app. */
  exit: () => void;
}

export interface Command {
  name: string;
  summary: string;
  run: (ctx: CommandContext, args: string[]) => void;
}

// Whitespace-split args suffice while commands take at most a bare id; defer a
// quote-aware tokenizer + schema until one needs structured arguments.
export const commands: Command[] = [
  { name: "help", summary: "list commands", run: (ctx) => ctx.note(helpText()) },
  { name: "clear", summary: "clear the transcript", run: (ctx) => ctx.clear() },
  {
    name: "resume",
    summary: "switch conversation (/resume <id>, or /resume to pick)",
    run: (ctx, args) => ctx.resume(args[0]),
  },
  {
    name: "model",
    summary: "switch model (/model <id>, or /model to pick)",
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
    name: "effort",
    summary: "set reasoning effort (/effort <value>, or /effort to pick)",
    run: (ctx, args) => {
      const efforts = effortsFor(ctx.service, ctx.model);
      if (efforts.length === 0) {
        ctx.note(`${ctx.model.model} has no effort options`);
        return;
      }
      const value = args[0];
      if (!value) {
        ctx.pickEffort();
        return;
      }
      if (!efforts.some((e) => e.value === value)) {
        ctx.note(`unknown effort: ${value} (try: ${efforts.map((e) => e.value).join(", ")})`);
        return;
      }
      const model = { ...ctx.model, effort: value };
      void ctx.service.setModel(ctx.conversationId, model).then(
        () => ctx.note(`effort → ${selectionId(model)}`),
        (e: unknown) => ctx.note(`effort switch failed: ${String(e)}`),
      );
    },
  },
  { name: "activities", summary: "show running activities", run: (ctx) => ctx.showActivities() },
  { name: "exit", summary: "quit", run: (ctx) => ctx.exit() },
  {
    name: "tick",
    summary: "send a demo external-input turn",
    run: (ctx) => {
      setTimeout(() => void ctx.service.send(ctx.conversationId, "(external tick)"), 500);
    },
  },
];

const byName = new Map(commands.map((c) => [c.name, c]));

/** Dispatch a `/command [args…]` line. Returns false if the command is unknown. */
export function runCommand(line: string, ctx: CommandContext): boolean {
  const [name, ...args] = line.slice(1).trim().split(/\s+/);
  const command = byName.get(name ?? "");
  if (!command) return false;
  command.run(ctx, args);
  return true;
}

const helpText = (): string => commands.map((c) => `  /${c.name} — ${c.summary}`).join("\n");
