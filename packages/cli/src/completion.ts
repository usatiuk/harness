import { byName, commands, type Command, type CommandContext } from "./commands.ts";

export interface Suggestion {
  /** Text inserted into the line when this item is accepted. */
  value: string;
  /** Display label (usually equal to `value`). */
  label: string;
  /** Optional dimmed description shown beside the label. */
  summary?: string;
  /** Append a space after inserting (so a completed command flows into its arguments). */
  appendSpace?: boolean;
}

export interface Completion {
  items: Suggestion[];
  /** Half-open `[start, end)` char span in the line that accepting replaces. */
  range: [number, number];
}

/**
 * A completion source for one trigger (slash commands, `@` files, …). Returns
 * `null` when it does not apply to the current input, so providers compose.
 */
export interface CompletionProvider {
  complete(line: string, cursor: number, ctx: CommandContext): Completion | null;
}

/** Ask each provider in order; the first non-null result wins. */
export function complete(
  providers: CompletionProvider[],
  line: string,
  cursor: number,
  ctx: CommandContext,
): Completion | null {
  for (const provider of providers) {
    const result = provider.complete(line, cursor, ctx);
    if (result) return result;
  }
  return null;
}

/** True when every char of `needle` appears in order within `hay`. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (i < needle.length && ch === needle[i]) i++;
  }
  return i === needle.length;
}

/** Rank a command name against a partial: exact > prefix > subsequence > no match. */
function score(name: string, partial: string): number {
  const n = name.toLowerCase();
  if (n === partial) return 3;
  if (n.startsWith(partial)) return 2;
  if (isSubsequence(partial, n)) return 1;
  return 0;
}

/** Commands matching `partial`, best first; an empty partial lists all (registry order). */
function matchCommands(partial: string): Command[] {
  const p = partial.toLowerCase();
  if (p === "") return commands;
  // Array.sort is stable, so equal-score commands keep their declaration order.
  return commands
    .map((c) => ({ c, s: score(c.name, p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/**
 * Slash-command completion, kept generic over the registry: it filters command
 * names, and delegates argument completion to each command's own `complete` hook
 * — so the engine never hard-codes a specific command.
 */
export const slashCompletion: CompletionProvider = {
  complete(line, cursor, ctx) {
    if (!line.startsWith("/")) return null;
    // Single-line: only complete at end of line, so accepting never splices text
    // behind a mid-line cursor.
    if (cursor !== line.length) return null;
    const body = line.slice(1);
    const space = body.indexOf(" ");

    if (space === -1) {
      // Name stage: still typing the command itself.
      const items: Suggestion[] = matchCommands(body).map((c) => ({
        value: "/" + c.name,
        label: "/" + c.name,
        summary: c.summary,
        appendSpace: !!c.complete,
      }));
      return { items, range: [0, line.length] };
    }

    // Argument stage: delegate to the command's own completer.
    const command = byName.get(body.slice(0, space));
    if (!command?.complete) return null;
    const args = body.slice(space + 1).split(/\s+/);
    const partial = (args[args.length - 1] ?? "").toLowerCase();
    // Substring (not prefix): a "provider/model" id should match a typed "gpt".
    const items = command
      .complete(ctx, args)
      .filter((s) => s.value.toLowerCase().includes(partial));
    return { items, range: [line.length - partial.length, line.length] };
  },
};
