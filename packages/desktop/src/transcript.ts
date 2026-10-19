import type { Cell } from "@harness/client-features/transcript-reducer";

interface CellRow {
  key: string;
  cell: Cell;
}
export interface ToolCallRow extends CellRow {
  cell: Extract<Cell, { kind: "tool" }>;
  boundary?: "begin" | "result";
}
type MessageCell = Extract<Cell, { kind: "user" | "assistant" }>;
type WorkCell = Exclude<Cell, MessageCell | { kind: "tool" }>;
export type TranscriptStep = ToolCallRow | { key: string; cell: WorkCell };
export type TranscriptRow =
  | { kind: "cell"; key: string; cell: MessageCell }
  | {
      kind: "steps";
      key: string;
      steps: [TranscriptStep, ...TranscriptStep[]];
      observedTiming?: { startedAt: number; completedAt?: number };
    };

const durableKey = (cell: Cell): string | undefined =>
  cell.kind === "tool"
    ? `tool:${cell.id ?? JSON.stringify([cell.turnId, cell.callId])}`
    : "id" in cell && cell.id
      ? `${cell.kind}:${cell.id}`
      : undefined;
const streamKey = (cell: Cell): string | undefined =>
  cell.kind === "assistant" || cell.kind === "reasoning"
    ? `${cell.kind}:${cell.turnId}`
    : undefined;

/** Desktop row identity survives streamed content gaining its durable item id. */
export class DesktopTranscript {
  rows: TranscriptRow[] = [];
  private cells: readonly Cell[] = [];
  private keys = new Map<Cell, string>();
  private sequence = 0;
  private activeTurnId: string | undefined;

  update(cells: readonly Cell[], activeTurnId?: string): void {
    const turnChanged = this.activeTurnId !== activeTurnId;
    this.activeTurnId = activeTurnId;
    if (cells === this.cells) {
      if (turnChanged) this.updateTiming(activeTurnId, Date.now());
      return;
    }
    const previousRows = new Map(this.rows.map((row) => [row.key, row]));
    const previousSteps = new Map(
      this.rows.flatMap((row) =>
        row.kind === "steps" ? row.steps.map((step) => [step.key, step] as const) : [],
      ),
    );
    const previousGroups = new Map(
      this.rows.flatMap((row) =>
        row.kind === "steps" ? row.steps.map((step) => [step.key, row.key] as const) : [],
      ),
    );
    const previousTimings = new Map<string, { startedAt: number; completedAt?: number }>();
    for (const row of this.rows) {
      if (row.kind === "steps" && row.observedTiming)
        for (const step of row.steps) previousTimings.set(step.key, row.observedTiming);
    }
    const now = Date.now();
    const nextCells = new Set(cells);
    const durable = new Map<string, string>();
    const replacements = new Map<string, string>();
    for (const [cell, key] of this.keys) {
      const id = durableKey(cell);
      if (id) durable.set(id, key);
      // History prepend keeps existing cell objects; it must not consume an open
      // stream's identity for an older block belonging to the same turn.
      if (
        (cell.kind === "assistant" || cell.kind === "reasoning") &&
        cell.streaming &&
        !nextCells.has(cell)
      )
        replacements.set(streamKey(cell)!, key);
    }
    const keys = new Map<Cell, string>();
    const rows: CellRow[] = [];
    const tools = new Map<string, number>();
    for (const cell of cells) {
      const id = durableKey(cell);
      const stream = streamKey(cell);
      let key = this.keys.get(cell) ?? (id ? durable.get(id) : undefined);
      if (!key && stream) {
        key = replacements.get(stream);
        replacements.delete(stream);
      }
      key ??= id ?? `stream:${this.sequence++}`;
      keys.set(cell, key);
      const row = { key, cell } satisfies CellRow;
      rows.push(row);
      if (cell.kind === "tool")
        tools.set(JSON.stringify([cell.turnId, cell.callId]), rows.length - 1);
    }
    // Results follow the last available descendant, without nesting or hiding
    // child calls behind the parent's argument disclosure.
    const ends = rows.map((_, index) => index);
    const results = new Map<number, ToolCallRow[]>();
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!;
      if (row.cell.kind !== "tool") continue;
      const parent = row.cell.parentCallId
        ? tools.get(JSON.stringify([row.cell.turnId, row.cell.parentCallId]))
        : undefined;
      if (parent !== undefined) ends[parent] = Math.max(ends[parent]!, ends[index]!);
      if (row.cell.name === "eval" && row.cell.status) {
        const end = ends[index]!;
        const closing = results.get(end) ?? [];
        closing.push({ key: `eval-result:${row.key}`, cell: row.cell, boundary: "result" });
        results.set(end, closing);
      }
    }
    this.rows = [];
    const flat: (CellRow | ToolCallRow)[] = [];
    rows.forEach((row, index) => {
      flat.push(
        row.cell.kind === "tool" && row.cell.name === "eval"
          ? { ...row, cell: row.cell, boundary: "begin" }
          : row,
      );
      flat.push(...(results.get(index) ?? []));
    });
    for (const row of flat) {
      const previous = this.rows.at(-1);
      if (row.cell.kind !== "user" && row.cell.kind !== "assistant") {
        const step: TranscriptStep =
          row.cell.kind === "tool" ? { ...row, cell: row.cell } : { key: row.key, cell: row.cell };
        if (previous?.kind === "steps") previous.steps.push(step);
        else this.rows.push({ kind: "steps", key: row.key, steps: [step] });
      } else this.rows.push({ kind: "cell", key: row.key, cell: row.cell });
    }
    // A history prepend may extend an existing group at its head. Its mounted
    // owner follows the overlapping group, not the newly first historical step.
    const groupKeys = new Set<string>();
    for (const row of this.rows) {
      if (row.kind !== "steps") continue;
      const previous = row.steps
        .map((step) => previousGroups.get(step.key))
        .find((key) => key !== undefined && !groupKeys.has(key));
      if (previous) row.key = previous;
      groupKeys.add(row.key);
    }
    // Live elapsed labels use one client clock. Server history timestamps cannot
    // be subtracted from locally observed reasoning starts on remote connections.
    for (const row of this.rows) {
      if (row.kind !== "steps") continue;
      const previous = row.steps
        .map((step) => previousTimings.get(step.key))
        .find((timing) => timing !== undefined);
      if (previous) row.observedTiming = previous;
    }
    this.updateTiming(
      activeTurnId,
      now,
      new Set([...keys.values()].filter((key) => !previousSteps.has(key))),
    );
    this.rows = this.rows.map((row) => {
      const previous = previousRows.get(row.key);
      if (row.kind === "cell")
        return previous?.kind === "cell" && previous.cell === row.cell ? previous : row;
      row.steps = row.steps.map((step) => {
        const previous = previousSteps.get(step.key);
        return previous?.cell === step.cell &&
          ("boundary" in previous ? previous.boundary : undefined) ===
            ("boundary" in step ? step.boundary : undefined)
          ? previous
          : step;
      }) as typeof row.steps;
      return previous?.kind === "steps" &&
        previous.observedTiming === row.observedTiming &&
        previous.steps.length === row.steps.length &&
        previous.steps.every((step, index) => step === row.steps[index])
        ? previous
        : row;
    });
    this.keys = keys;
    this.cells = cells;
  }

  private updateTiming(
    activeTurnId: string | undefined,
    now: number,
    newKeys: ReadonlySet<string> = new Set(),
  ): void {
    const boundary =
      activeTurnId === undefined
        ? -1
        : this.rows.findLastIndex((row) => row.kind === "cell" && row.cell.turnId === activeTurnId);
    const active =
      activeTurnId === undefined
        ? undefined
        : this.rows.findLast((row, index) => {
            if (row.kind !== "steps") return false;
            if (row.steps.some(({ cell }) => "turnId" in cell && cell.turnId === activeTurnId))
              return true;
            if (row.steps.some(({ cell }) => "turnId" in cell && cell.turnId !== undefined))
              return false;
            if (boundary >= 0 && index > boundary) return true;
            if (row.observedTiming && row.observedTiming.completedAt === undefined) return true;
            // Context-only activity has no turn ID. Observe newly arriving live
            // context, not prepended history or completed standalone tool cells.
            return (
              row === this.rows.at(-1) &&
              row.steps.some(
                ({ key, cell }) =>
                  newKeys.has(key) &&
                  (cell.kind === "context" ||
                    cell.kind === "compaction" ||
                    (cell.kind === "shell" && cell.streaming)),
              )
            );
          });
    let changed = false;
    const rows = this.rows.map((row): TranscriptRow => {
      if (row.kind !== "steps") return row;
      const previous = row.observedTiming;
      if (row === active && (!previous || previous.completedAt !== undefined)) {
        changed = true;
        return { ...row, observedTiming: { startedAt: previous?.startedAt ?? now } };
      }
      if (row !== active && previous && previous.completedAt === undefined) {
        changed = true;
        return { ...row, observedTiming: { ...previous, completedAt: now } };
      }
      return row;
    });
    if (changed) this.rows = rows;
  }
}
