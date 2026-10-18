import { splitCustomEscalation } from "@harness/execution/presentation";
import { parseEnvelope, type FileChange } from "@harness/workspace/presentation";
import type { Cell } from "./transcript-reducer.ts";

export type PatchLineKind = "add" | "remove" | "hunk" | "context";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchFile {
  path: string;
  lines: PatchLine[];
}

export interface EditPresentation {
  labels: { running: string; succeeded: string; failed: string };
  files: PatchFile[];
}

const recordArgs = (args: unknown): Record<string, unknown> | undefined =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;

const stringField = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? args[key] : undefined;

const prefixedLines = (value: string, prefix: "+" | "-"): PatchLine[] =>
  value.split("\n").map((line) => ({
    kind: prefix === "+" ? "add" : "remove",
    text: `${prefix}${line}`,
  }));

const patchLines = (diff: string): PatchLine[] =>
  diff.split("\n").map((text) => ({
    kind: text.startsWith("+")
      ? "add"
      : text.startsWith("-")
        ? "remove"
        : text.startsWith("@@")
          ? "hunk"
          : "context",
    text,
  }));

const fileOfChange = (change: FileChange): PatchFile => {
  switch (change.type) {
    case "create_file":
      return { path: change.path, lines: patchLines(change.diff) };
    case "update_file":
      return {
        path: change.newPath ? `${change.path} → ${change.newPath}` : change.path,
        lines: patchLines(change.diff),
      };
    case "delete_file":
      return { path: change.path, lines: [{ kind: "remove", text: "deleted file" }] };
  }
};

const labels = (
  running: string,
  succeeded: string,
  failed: string,
): EditPresentation["labels"] => ({ running, succeeded, failed });

const applyPatchPresentation = (args: unknown): EditPresentation | undefined => {
  const patch = typeof args === "string" ? args : recordArgs(args)?.patch;
  if (typeof patch !== "string") return undefined;
  try {
    const changes = parseEnvelope(splitCustomEscalation(patch).input);
    if (changes.length === 0) return undefined;
    const first = changes[0]!;
    const operationLabels =
      changes.length > 1
        ? labels(
            `Updating ${changes.length} files`,
            `Updated ${changes.length} files`,
            `Failed to update ${changes.length} files`,
          )
        : first.type === "create_file"
          ? labels(
              `Creating ${first.path}`,
              `Created ${first.path}`,
              `Failed to create ${first.path}`,
            )
          : first.type === "delete_file"
            ? labels(
                `Deleting ${first.path}`,
                `Deleted ${first.path}`,
                `Failed to delete ${first.path}`,
              )
            : first.newPath
              ? labels(
                  `Moving ${first.path} → ${first.newPath}`,
                  `Moved ${first.path} → ${first.newPath}`,
                  `Failed to move ${first.path} → ${first.newPath}`,
                )
              : labels(
                  `Updating ${first.path}`,
                  `Updated ${first.path}`,
                  `Failed to update ${first.path}`,
                );
    return { labels: operationLabels, files: changes.map(fileOfChange) };
  } catch {
    return undefined;
  }
};

const structuredEditPresentation = (
  name: "edit" | "write",
  value: unknown,
): EditPresentation | undefined => {
  const args = recordArgs(value);
  if (!args) return undefined;
  const path = stringField(args, "path");
  if (!path) return undefined;
  if (name === "write") {
    const content = stringField(args, "content");
    return content === undefined
      ? undefined
      : {
          labels: labels(`Writing ${path}`, `Wrote ${path}`, `Failed to write ${path}`),
          files: [{ path, lines: prefixedLines(content, "+") }],
        };
  }
  const before = stringField(args, "old_string");
  const after = stringField(args, "new_string");
  return before === undefined || after === undefined
    ? undefined
    : {
        labels: labels(`Editing ${path}`, `Edited ${path}`, `Failed to edit ${path}`),
        files: [
          {
            path,
            lines: [...prefixedLines(before, "-"), ...prefixedLines(after, "+")],
          },
        ],
      };
};

export function editPresentation(
  cell: Extract<Cell, { kind: "tool" }>,
): EditPresentation | undefined {
  switch (cell.name) {
    case "apply_patch":
      return applyPatchPresentation(cell.args);
    case "edit":
    case "write":
      return structuredEditPresentation(cell.name, cell.args);
    default:
      return undefined;
  }
}
