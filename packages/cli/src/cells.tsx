import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { assertNever } from "@harness/protocol";
import type { Cell } from "./transcript-reducer.ts";

const TOOL_OUTPUT_CAP = 800;
const ARGS_CAP = 120;

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}… (+${s.length - n})` : s;

export const indent = (s: string): string =>
  s
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

/** A stable React/Static key for a cell (finalized cells all carry an id/callId). */
export function cellKey(cell: Cell): string {
  switch (cell.kind) {
    case "user":
      return cell.id;
    case "assistant":
      return cell.id ?? `${cell.turnId}:assistant`;
    case "reasoning":
      return cell.id ?? `${cell.turnId}:reasoning`;
    case "tool":
      return cell.callId;
    case "compaction":
    case "context":
    case "error":
    case "note":
      return cell.id;
    default:
      return assertNever(cell);
  }
}

/** Turns one transcript cell into Ink nodes. Pure presentation — no service/state. */
export function CellView({ cell }: { cell: Cell }): ReactElement {
  switch (cell.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan">{"› "}</Text>
          <Text>{cell.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{cell.text}</Text>;
    case "reasoning":
      return <Text dimColor>{cell.text}</Text>;
    case "tool":
      return <ToolCard cell={cell} />;
    case "compaction":
      return <Text dimColor>✦ context compacted</Text>;
    case "context":
      return <Text dimColor>{`✦ ${truncate(cell.text.split("\n")[0] ?? "", ARGS_CAP)}`}</Text>;
    case "error":
      return <Text color="red">{`✗ ${cell.text}`}</Text>;
    case "note":
      return <Text dimColor>{cell.text}</Text>;
    default:
      return assertNever(cell);
  }
}

function ToolCard({ cell }: { cell: Extract<Cell, { kind: "tool" }> }): ReactElement {
  const color = cell.status === "error" ? "red" : cell.status === "ok" ? "green" : "yellow";
  const mark = cell.status === undefined ? "⠿" : cell.status === "ok" ? "✓" : "✗";
  const args = truncate(safeArgs(cell.args), ARGS_CAP);
  return (
    <Box flexDirection="column">
      <Text color={color}>{`${mark} ${cell.name}(${args})`}</Text>
      {cell.output ? <Text dimColor>{indent(truncate(cell.output, TOOL_OUTPUT_CAP))}</Text> : null}
    </Box>
  );
}

const safeArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "…";
  }
};
