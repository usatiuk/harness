/**
 * The V4A `apply_patch` envelope GPT-family models emit: its Lark grammar (for
 * grammar-constrained freeform tool use) and a splitter into per-file changes.
 *
 * `APPLY_PATCH_LARK` is copied verbatim from the Codex CLI's `apply_patch.lark`
 * (github.com/openai/codex, codex-rs/core/src/tools/handlers/apply_patch.lark),
 * Copyright 2025 OpenAI, licensed under the Apache License, Version 2.0. `parseEnvelope`
 * is an independent implementation of the same V4A format.
 */

/** Lark grammar describing a V4A patch envelope. Verbatim from Codex's `apply_patch.lark`. */
export const APPLY_PATCH_LARK = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

/** One file operation parsed from an envelope. `diff` is the headerless V4A body. */
export type FileChange =
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; newPath?: string; diff: string }
  | { type: "delete_file"; path: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

/** A line that opens a new hunk or closes the envelope — i.e. ends the current hunk's body. */
function isBoundary(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(UPDATE) || line.startsWith(DELETE) || line === END;
}

/**
 * Splits a V4A patch envelope into per-file changes. Throws on a malformed envelope (missing
 * markers or an unrecognized line) — the caller turns that into a tool error.
 */
export function parseEnvelope(patch: string): FileChange[] {
  const lines = patch.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i] !== BEGIN) throw new Error(`apply_patch: expected "${BEGIN}"`);
  i++;

  const changes: FileChange[] = [];
  const body = (): string => {
    const start = i;
    while (i < lines.length && !isBoundary(lines[i]!)) i++;
    return lines.slice(start, i).join("\n");
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line === END) return changes;
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length);
      i++;
      changes.push({ type: "create_file", path, diff: body() });
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length);
      i++;
      let newPath: string | undefined;
      if (i < lines.length && lines[i]!.startsWith(MOVE)) {
        newPath = lines[i]!.slice(MOVE.length);
        i++;
      }
      changes.push({ type: "update_file", path, ...(newPath ? { newPath } : {}), diff: body() });
    } else if (line.startsWith(DELETE)) {
      changes.push({ type: "delete_file", path: line.slice(DELETE.length) });
      i++;
    } else if (line.trim() === "") {
      i++; // tolerate blank lines between hunks
    } else {
      throw new Error(`apply_patch: unexpected line: ${line}`);
    }
  }
  throw new Error(`apply_patch: missing "${END}"`);
}
