import { createContext, useContext, type ReactElement } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { assertNever, selectionId, type ToolStatus } from "@harness/protocol";
import type { Cell } from "./transcript-reducer.ts";
import { Markdown } from "./markdown.tsx";
import {
  editPresentation,
  type EditPresentation,
  type PatchFile,
  type PatchLine,
} from "./edit-presentation.ts";
import {
  formatDuration,
  type ExplorationAction,
  type ExplorationStage,
  type ThoughtStage,
} from "./transcript-layout.ts";

const TOOL_OUTPUT_CAP = 800;
const ARGS_CAP = 120;
const RESULT_CAP = 100;
const PATCH_LINE_CAP = 12;
const PATCH_COLUMN_CAP = 160;
// Left gutter: markers/symbols sit at column 0, textual content indented here —
// gives assistant markdown breathing room and a home for tool-call markers.
const GUTTER = 2;

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}… (+${s.length - n})` : s;

export const indent = (s: string): string =>
  s
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

/** Compact-by-default ⟺ false (Ctrl+O flips it in the app). */
export const VerboseContext = createContext(false);

const safeArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "…";
  }
};

// The scalar that best names the call — a command/path/pattern/etc — across the built-in
// tools; anything else falls back to a truncated JSON blob.
const SUMMARY_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "file",
  "pattern",
  "query",
  "url",
  "prompt",
];

/** Short human label for a tool call's args, truncated to ARGS_CAP. */
export function toolSummary(args: unknown): string {
  if (args && typeof args === "object") {
    for (const k of SUMMARY_KEYS) {
      const v = (args as Record<string, unknown>)[k];
      if (typeof v === "string" && v !== "") return truncate(v, ARGS_CAP);
    }
  }
  return truncate(safeArgs(args), ARGS_CAP);
}

/** First non-empty line of `s`, trimmed; undefined when blank. */
const firstLine = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  return s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
};

/** Turns one transcript cell into Ink nodes. Pure presentation — no service/state. */
export function CellView({ cell }: { cell: Cell }): ReactElement {
  const verbose = useContext(VerboseContext);
  switch (cell.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan">{"› "}</Text>
          <Text>{cell.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box paddingLeft={GUTTER}>
          <Markdown text={cell.text} streaming={cell.streaming} />
        </Box>
      );
    case "reasoning":
      // Stream the live thought in full; collapse finalized thoughts unless verbose.
      return cell.streaming || verbose ? (
        <Box paddingLeft={GUTTER}>
          <Markdown text={cell.text} streaming={cell.streaming} dim />
        </Box>
      ) : (
        <Text dimColor>✻ thought</Text>
      );
    case "tool":
      return <ToolCard cell={cell} verbose={verbose} />;
    case "compaction":
      return verbose ? (
        <Box flexDirection="column">
          <Text dimColor>✦ context compacted</Text>
          <Box paddingLeft={GUTTER}>
            <Markdown text={cell.text} dim />
          </Box>
        </Box>
      ) : (
        <Text dimColor>✦ context compacted</Text>
      );
    case "context":
      return <Text dimColor>{`✦ ${truncate(cell.text.split("\n")[0] ?? "", ARGS_CAP)}`}</Text>;
    case "error":
      return <Text color="red">{`✗ ${cell.text}`}</Text>;
    case "worked":
      return <WorkFooterView duration={cell.duration} />;
    case "note":
      return <Text dimColor>{cell.text}</Text>;
    case "shell":
      return <ShellCard cell={cell} />;
    default:
      return assertNever(cell);
  }
}

export function ExplorationChildren({ actions }: { actions: ExplorationAction[] }): ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {actions.map((action, index) => (
        <Text key={action.callId} dimColor>
          {`${index === actions.length - 1 ? "└" : "├"} ${action.kind === "read" ? "Read" : "Search"} ${truncate(action.target, ARGS_CAP)}`}
        </Text>
      ))}
    </Box>
  );
}

export function ExplorationView({ stage }: { stage: ExplorationStage }): ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>• Explored</Text>
      <ExplorationChildren actions={stage.actions} />
    </Box>
  );
}

export function WorkFooterView({ duration }: { duration?: number }): ReactElement {
  return duration === undefined ? (
    <Spinner label="Working…" />
  ) : (
    <Text dimColor>{`• Worked for ${formatDuration(duration)}`}</Text>
  );
}

export function ThoughtView({ thought }: { thought: ThoughtStage }): ReactElement {
  return (
    <Text dimColor>
      {thought.duration === undefined
        ? "• Thought"
        : `• Thought for ${formatDuration(thought.duration)}`}
    </Text>
  );
}

function ShellCard({ cell }: { cell: Extract<Cell, { kind: "shell" }> }): ReactElement {
  const failed = !cell.streaming && (cell.exitCode ?? 0) !== 0;
  return (
    <Box flexDirection="column">
      <Text color="cyan">{`$ ${cell.command}`}</Text>
      {cell.text ? <Text dimColor>{indent(cell.text)}</Text> : null}
      {failed ? <Text color="red">{`   (exit ${cell.exitCode})`}</Text> : null}
    </Box>
  );
}

function ToolCard({
  cell,
  verbose,
}: {
  cell: Extract<Cell, { kind: "tool" }>;
  verbose: boolean;
}): ReactElement {
  const edit = editPresentation(cell);
  if (edit) return <EditCard cell={cell} edit={edit} verbose={verbose} />;
  const color = cell.status === "error" ? "red" : cell.status === "ok" ? "green" : "yellow";
  const mark = cell.status === undefined ? "⠿" : cell.status === "ok" ? "✓" : "✗";
  const approvalDenied = cell.approval?.decision === "deny";
  if (verbose) {
    const args = truncate(safeArgs(cell.args), ARGS_CAP);
    return (
      <Box flexDirection="column">
        <Text
          color={color}
        >{`${cell.parentCallId ? "  ↳ " : ""}${mark} ${cell.name}(${args})`}</Text>
        {cell.output && !approvalDenied ? (
          <Text dimColor>{indent(truncate(cell.output, TOOL_OUTPUT_CAP))}</Text>
        ) : null}
        <ApprovalLine cell={cell} />
      </Box>
    );
  }
  const summary = toolSummary(cell.args);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{`${cell.parentCallId ? "  ↳ " : ""}${mark} ${cell.name}`}</Text>
        {summary ? <Text dimColor>{`  ${summary}`}</Text> : null}
      </Text>
      <ApprovalLine cell={cell} />
      {approvalDenied ? null : <ResultLine status={cell.status} output={cell.output} />}
    </Box>
  );
}

function EditCard({
  cell,
  edit,
  verbose,
}: {
  cell: Extract<Cell, { kind: "tool" }>;
  edit: EditPresentation;
  verbose: boolean;
}): ReactElement {
  const color = cell.status === "error" ? "red" : cell.status === "ok" ? "green" : "yellow";
  const mark = cell.status === undefined ? "⠿" : cell.status === "ok" ? "✓" : "✗";
  const approvalDenied = cell.approval?.decision === "deny";
  const label =
    cell.status === undefined
      ? edit.labels.running
      : cell.status === "ok"
        ? edit.labels.succeeded
        : edit.labels.failed;
  return (
    <Box flexDirection="column">
      <Text color={color}>{`${cell.parentCallId ? "  ↳ " : ""}${mark} ${label}`}</Text>
      {cell.status === "error" ? (
        <Text dimColor>{approvalDenied ? " requested changes:" : " attempted changes:"}</Text>
      ) : null}
      <PatchView edit={edit} verbose={verbose} />
      <ApprovalLine cell={cell} />
      {cell.status === "error" && !approvalDenied ? (
        <ResultLine status={cell.status} output={cell.output} />
      ) : null}
    </Box>
  );
}

function compactPatchFiles(files: PatchFile[]): PatchFile[] {
  let remaining = PATCH_LINE_CAP;
  return files.map((file) => {
    const lines = file.lines.slice(0, remaining);
    remaining -= lines.length;
    return { ...file, lines };
  });
}

function PatchView({ edit, verbose }: { edit: EditPresentation; verbose: boolean }): ReactElement {
  const totalLines = edit.files.reduce((sum, file) => sum + file.lines.length, 0);
  const files = verbose ? edit.files : compactPatchFiles(edit.files);
  const shown = files.reduce((sum, file) => sum + file.lines.length, 0);
  const showFileHeaders = edit.files.length > 1;
  return (
    <Box flexDirection="column" paddingLeft={GUTTER}>
      {files.map((file, fileIndex) => (
        <Box key={`${fileIndex}:${file.path}`} flexDirection="column">
          {showFileHeaders ? <Text color="cyan">{file.path}</Text> : null}
          {file.lines.map((line, index) => (
            <PatchLineView key={`${index}:${line.text}`} line={line} verbose={verbose} />
          ))}
        </Box>
      ))}
      {shown < totalLines ? <Text dimColor>{`… ${totalLines - shown} more lines`}</Text> : null}
    </Box>
  );
}

function PatchLineView({ line, verbose }: { line: PatchLine; verbose: boolean }): ReactElement {
  const text = verbose ? line.text : truncate(line.text, PATCH_COLUMN_CAP);
  switch (line.kind) {
    case "add":
      return <Text color="green">{text}</Text>;
    case "remove":
      return <Text color="red">{text}</Text>;
    case "hunk":
      return <Text color="cyan">{text}</Text>;
    case "context":
      return <Text dimColor>{text}</Text>;
  }
}

function ApprovalLine({ cell }: { cell: Extract<Cell, { kind: "tool" }> }): ReactElement | null {
  const final = cell.approval;
  if (final) {
    const who =
      final.responder === "auto"
        ? `auto approver${final.model ? ` (${selectionId(final.model)})` : ""}`
        : final.responder === "human"
          ? "user"
          : "policy";
    const verb = final.decision === "allow" ? "approved" : "denied";
    const label = `  ⎿ ${who} ${verb}${final.reason ? `: ${truncate(final.reason, RESULT_CAP)}` : ""}`;
    return final.decision === "deny" ? (
      <Text color="red">{label}</Text>
    ) : (
      <Text dimColor>{label}</Text>
    );
  }
  const progress = cell.approvalProgress;
  if (!progress) return null;
  const who =
    progress.responder === "auto"
      ? `auto approver${progress.model ? ` (${selectionId(progress.model)})` : ""}`
      : progress.responder === "human"
        ? "user"
        : "policy";
  const action =
    progress.status === "reviewing"
      ? "reviewing…"
      : progress.status === "allow"
        ? "approved"
        : `denied${progress.reason ? `: ${truncate(progress.reason, RESULT_CAP)}` : ""}`;
  return (
    <Text
      color={progress.status === "deny" ? "red" : "yellow"}
      dimColor={progress.status === "allow"}
    >
      {`  ⎿ ${who} ${action}`}
    </Text>
  );
}

/** Compact one-line result: `⎿ <first line>` / `⎿ done` / `⎿ <error>` (red). Hidden while running. */
function ResultLine({
  status,
  output,
}: {
  status: ToolStatus | undefined;
  output: string | undefined;
}): ReactElement | null {
  if (status === undefined) return null;
  const first = firstLine(output);
  if (status === "error") return <Text color="red">{`  ⎿ ${first ?? "error"}`}</Text>;
  return first ? (
    <Text dimColor>{`  ⎿ ${truncate(first, RESULT_CAP)}`}</Text>
  ) : (
    <Text dimColor>{"  ⎿ done"}</Text>
  );
}
