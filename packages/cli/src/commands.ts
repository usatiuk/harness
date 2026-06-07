import type { ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";

/** What a slash command can act on. Kept narrow on purpose. */
export interface CommandContext {
  service: HarnessService;
  conversationId: ConversationId;
  /** Append a local note line (command output / errors) to the transcript. */
  note: (text: string) => void;
  /** Clear the visible transcript. */
  clear: () => void;
  /** Switch conversation: an id resumes it directly; omitting it opens the picker. */
  resume: (id?: string) => void;
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
