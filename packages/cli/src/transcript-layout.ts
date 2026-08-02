import type { Cell } from "./transcript-reducer.ts";

export interface WorkSummary {
  active: boolean;
  startedAt: number;
  completedAt: number;
  filesRead: number;
  searches: number;
  commands: number;
}

export type TranscriptEntry =
  | { kind: "cell"; key: string; cell: Cell; live: boolean }
  | { kind: "work"; key: string; summary: WorkSummary; live: boolean };

interface WorkAccumulator {
  firstIndex?: number;
  turnStartedAt?: number;
  startedAt?: number;
  completedAt?: number;
  readPaths: Set<string>;
  searches: number;
  commands: number;
  mutable: boolean;
}

type RoutineKind = { kind: "read"; path?: string } | { kind: "search" } | { kind: "command" };

const objectArgs = (args: unknown): Record<string, unknown> | undefined =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;

const stringArg = (args: unknown, key: string): string | undefined => {
  const value = objectArgs(args)?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

function routineKind(cell: Extract<Cell, { kind: "tool" }>): RoutineKind | undefined {
  switch (cell.name) {
    case "read_file": {
      const path = stringArg(cell.args, "path");
      return path ? { kind: "read", path } : { kind: "read" };
    }
    case "glob":
      return { kind: "search" };
    case "bash":
    case "powershell":
      return { kind: "command" };
    case "str_replace_based_edit_tool": {
      if (objectArgs(cell.args)?.command !== "view") return undefined;
      const path = stringArg(cell.args, "path");
      return path ? { kind: "read", path } : { kind: "read" };
    }
    default:
      return undefined;
  }
}

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
    case "note":
    case "shell":
      return cell.id;
  }
};

const accumulator = (map: Map<string, WorkAccumulator>, turnId: string): WorkAccumulator => {
  let value = map.get(turnId);
  if (!value) {
    value = { readPaths: new Set(), searches: 0, commands: 0, mutable: false };
    map.set(turnId, value);
  }
  return value;
};

const recordTime = (
  work: WorkAccumulator,
  cell: Extract<Cell, { kind: "reasoning" | "tool" }>,
): void => {
  work.startedAt = Math.min(work.startedAt ?? cell.startedAt, cell.startedAt);
  const completedAt = cell.completedAt ?? cell.startedAt;
  work.completedAt = Math.max(work.completedAt ?? completedAt, completedAt);
};

/**
 * Derives compact/verbose transcript entries without changing the canonical cell list.
 * A whole active turn remains mutable so its aggregate can settle before Ink publishes it.
 */
export function layoutTranscript(
  cells: Cell[],
  activeTurnId: string | undefined,
  verbose: boolean,
): TranscriptEntry[] {
  const workByTurn = new Map<string, WorkAccumulator>();

  cells.forEach((cell, index) => {
    const turnId = turnIdOf(cell);
    if (turnId === undefined) return;
    const work = accumulator(workByTurn, turnId);
    if (cell.kind === "user") {
      work.turnStartedAt = Math.min(work.turnStartedAt ?? cell.createdAt, cell.createdAt);
      return;
    }
    if (cell.kind === "reasoning") {
      work.firstIndex ??= index;
      recordTime(work, cell);
      work.mutable ||= cell.streaming;
      return;
    }
    if (cell.kind === "tool") {
      recordTime(work, cell);
      work.mutable ||= cell.status === undefined;
      const routine = routineKind(cell);
      if (!routine) return;
      if (cell.status === "error") return;
      work.firstIndex ??= index;
      if (cell.status === undefined) return;
      if (routine.kind === "read") {
        work.readPaths.add(routine.path ?? cell.callId);
      } else if (routine.kind === "search") {
        work.searches++;
      } else {
        work.commands++;
      }
    }
  });

  const entries: TranscriptEntry[] = [];
  cells.forEach((cell, index) => {
    const turnId = turnIdOf(cell);
    const work = turnId === undefined ? undefined : workByTurn.get(turnId);
    const active = turnId !== undefined && turnId === activeTurnId;
    if (
      turnId !== undefined &&
      work?.firstIndex === index &&
      work.startedAt !== undefined &&
      work.completedAt !== undefined
    ) {
      const live = active || work.mutable;
      entries.push({
        kind: "work",
        key: `${turnId}:work`,
        live,
        summary: {
          active: live,
          startedAt: Math.min(work.turnStartedAt ?? work.startedAt, work.startedAt),
          completedAt: work.completedAt,
          filesRead: work.readPaths.size,
          searches: work.searches,
          commands: work.commands,
        },
      });
    }

    const routine = cell.kind === "tool" ? routineKind(cell) : undefined;
    const collapsibleTool =
      cell.kind === "tool" &&
      routine !== undefined &&
      cell.status === "ok" &&
      cell.approval === undefined;
    const hiddenInCompact = !verbose && (cell.kind === "reasoning" || collapsibleTool);
    if (hiddenInCompact) return;
    entries.push({
      kind: "cell",
      key: cellIdentity(cell),
      cell,
      live: active || isMutableCell(cell),
    });
  });
  return entries;
}

export const liveEntryStartIndex = (entries: TranscriptEntry[]): number => {
  const first = entries.findIndex((entry) => entry.live);
  return first === -1 ? entries.length : first;
};

export function formatWorkSummary(summary: WorkSummary): string {
  const parts: string[] = [];
  if (summary.filesRead > 0) {
    parts.push(`read ${summary.filesRead} ${summary.filesRead === 1 ? "file" : "files"}`);
  }
  if (summary.searches > 0) {
    parts.push(`${summary.searches} ${summary.searches === 1 ? "search" : "searches"}`);
  }
  if (summary.commands > 0) {
    parts.push(`ran ${summary.commands} ${summary.commands === 1 ? "command" : "commands"}`);
  }
  const lead = summary.active
    ? "Working…"
    : `Worked for ${formatDuration(summary.completedAt - summary.startedAt)}`;
  return [lead, ...parts].join(" · ");
}

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
