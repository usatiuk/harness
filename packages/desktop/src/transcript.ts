import type { Cell } from "@harness/client-features/transcript-reducer";

interface CellRow {
  key: string;
  cell: Cell;
}
export interface ToolCallRow extends CellRow {
  cell: Extract<Cell, { kind: "tool" }>;
  boundary?: "begin" | "result";
}
export type TranscriptStep =
  ToolCallRow | { key: string; cell: Extract<Cell, { kind: "reasoning" }> };
export type TranscriptRow =
  | { kind: "cell"; key: string; cell: Exclude<Cell, { kind: "tool" | "reasoning" }> }
  | {
      kind: "steps";
      key: string;
      steps: [TranscriptStep, ...TranscriptStep[]];
      observedTiming?: { startedAt: number; completedAt?: number };
    };

const durableKey = (cell: Cell): string | undefined =>
  cell.kind === "tool"
    ? `tool:${cell.callId}`
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

  update(cells: readonly Cell[], activeTurnId?: string): void {
    if (cells === this.cells) {
      this.updateTiming(activeTurnId, Date.now());
      return;
    }
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
      if (cell.kind === "tool") tools.set(cell.callId, rows.length - 1);
    }
    // Results follow the last available descendant, without nesting or hiding
    // child calls behind the parent's argument disclosure.
    const ends = rows.map((_, index) => index);
    const results = new Map<number, ToolCallRow[]>();
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!;
      if (row.cell.kind !== "tool") continue;
      const parent = row.cell.parentCallId ? tools.get(row.cell.parentCallId) : undefined;
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
      if (row.cell.kind === "tool" || row.cell.kind === "reasoning") {
        const step: TranscriptStep =
          row.cell.kind === "tool" ? { ...row, cell: row.cell } : { key: row.key, cell: row.cell };
        if (previous?.kind === "steps") previous.steps.push(step);
        else this.rows.push({ kind: "steps", key: row.key, steps: [step] });
      } else this.rows.push({ kind: "cell", key: row.key, cell: row.cell });
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
    this.updateTiming(activeTurnId, now);
    this.keys = keys;
    this.cells = cells;
  }

  private updateTiming(activeTurnId: string | undefined, now: number): void {
    const active =
      activeTurnId === undefined
        ? undefined
        : this.rows.findLast(
            (row) =>
              row.kind === "steps" && row.steps.some(({ cell }) => cell.turnId === activeTurnId),
          );
    for (const row of this.rows) {
      if (row.kind !== "steps") continue;
      const previous = row.observedTiming;
      if (row === active) row.observedTiming = { startedAt: previous?.startedAt ?? now };
      else if (previous && previous.completedAt === undefined)
        row.observedTiming = { ...previous, completedAt: now };
    }
  }
}
