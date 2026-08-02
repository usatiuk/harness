import type { Cell } from "./transcript-reducer.ts";

export interface ExplorationAction {
  callId: string;
  kind: "read" | "search";
  target: string;
}

export interface ExplorationStage {
  actions: ExplorationAction[];
}

export interface ThoughtStage {
  duration?: number;
}

export type TranscriptEntry =
  | { kind: "cell"; key: string; cell: Cell; live: boolean }
  | { kind: "exploration"; key: string; stage: ExplorationStage; live: boolean }
  | { kind: "thought"; key: string; thought: ThoughtStage; live: false };

interface PendingExploration {
  key: string;
  turnId: string;
  actions: ExplorationAction[];
  mutable: boolean;
}

const objectArgs = (args: unknown): Record<string, unknown> | undefined =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;

const stringArg = (args: unknown, key: string): string | undefined => {
  const value = objectArgs(args)?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** A compact exploration child, or undefined when this tool must remain an explicit card. */
const explorationAction = (
  cell: Extract<Cell, { kind: "tool" }>,
): ExplorationAction | undefined => {
  if (cell.status === "error" || cell.approval || cell.approvalProgress) return undefined;
  switch (cell.name) {
    case "read_file":
      return {
        callId: cell.callId,
        kind: "read",
        target: stringArg(cell.args, "path") ?? "file",
      };
    case "glob": {
      const pattern = stringArg(cell.args, "pattern") ?? "files";
      const path = stringArg(cell.args, "path");
      return {
        callId: cell.callId,
        kind: "search",
        target: path && path !== "." ? `${pattern} in ${path}` : pattern,
      };
    }
    case "str_replace_based_edit_tool":
      if (objectArgs(cell.args)?.command !== "view") return undefined;
      return {
        callId: cell.callId,
        kind: "read",
        target: stringArg(cell.args, "path") ?? "file",
      };
    default:
      return undefined;
  }
};

const turnIdOf = (cell: Cell): string | undefined => {
  switch (cell.kind) {
    case "user":
    case "assistant":
    case "reasoning":
    case "tool":
      return cell.turnId;
    case "compaction":
    case "context":
    case "error":
    case "worked":
    case "note":
    case "shell":
      return undefined;
  }
};

const isMutableCell = (cell: Cell): boolean => {
  if (cell.kind === "assistant" || cell.kind === "reasoning" || cell.kind === "shell") {
    return cell.streaming;
  }
  return cell.kind === "tool" && cell.status === undefined;
};

const cellIdentity = (cell: Cell): string => {
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
    case "worked":
    case "note":
    case "shell":
      return cell.id;
  }
};

/**
 * Derives chronological compact stages without changing the granular reducer cells. Finalized
 * prefixes can enter Ink Static immediately; only genuinely mutable cells or stages remain live.
 */
export function layoutTranscript(cells: Cell[], verbose: boolean): TranscriptEntry[] {
  if (verbose) {
    return cells.map((cell) => ({
      kind: "cell",
      key: cellIdentity(cell),
      cell,
      live: isMutableCell(cell),
    }));
  }

  const entries: TranscriptEntry[] = [];
  let exploration: PendingExploration | undefined;

  const flushExploration = (): void => {
    if (!exploration) return;
    entries.push({
      kind: "exploration",
      key: exploration.key,
      stage: { actions: exploration.actions },
      // A stage followed by narration is visually complete, but cannot freeze until every call has
      // settled: a late failure/approval must still turn its child back into an explicit card.
      live: exploration.mutable,
    });
    exploration = undefined;
  };

  for (const cell of cells) {
    const action = cell.kind === "tool" ? explorationAction(cell) : undefined;
    const mutableAction = cell.kind === "tool" && cell.status === undefined;
    const turnId = turnIdOf(cell);
    if (action && turnId) {
      if (exploration && exploration.turnId !== turnId) flushExploration();
      exploration ??= {
        key: `${turnId}:exploration:${action.callId}`,
        turnId,
        actions: [],
        mutable: false,
      };
      exploration.actions.push(action);
      exploration.mutable ||= mutableAction;
      continue;
    }

    flushExploration();
    if (cell.kind === "reasoning" && !cell.streaming) {
      entries.push({
        kind: "thought",
        key: cellIdentity(cell),
        thought: cell.observedTiming
          ? { duration: Math.max(0, (cell.completedAt ?? cell.startedAt) - cell.startedAt) }
          : {},
        live: false,
      });
      continue;
    }
    entries.push({
      kind: "cell",
      key: cellIdentity(cell),
      cell,
      live: isMutableCell(cell),
    });
  }
  flushExploration();
  return entries;
}

export const liveEntryStartIndex = (entries: TranscriptEntry[]): number => {
  const first = entries.findIndex((entry) => entry.live);
  return first === -1 ? entries.length : first;
};

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h ${minuteRemainder}m`;
}
