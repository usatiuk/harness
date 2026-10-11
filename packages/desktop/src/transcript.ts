import type { Cell } from "@harness/client-features/transcript-reducer";

interface CellRow {
  key: string;
  cell: Cell;
  children: Cell[];
}
export interface ToolCallRow extends CellRow {
  cell: Extract<Cell, { kind: "tool" }>;
}
export type TranscriptRow =
  | { kind: "cell"; key: string; cell: Exclude<Cell, { kind: "tool" }> }
  | { kind: "tools"; key: string; tools: [ToolCallRow, ...ToolCallRow[]] };

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

  update(cells: readonly Cell[]): void {
    if (cells === this.cells) return;
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
    const tools = new Map<string, CellRow>();
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
      const row = { key, cell, children: [] } satisfies CellRow;
      rows.push(row);
      if (cell.kind === "tool") tools.set(cell.callId, row);
    }
    const roots = rows.filter((row) => {
      const cell = row.cell;
      if (cell.kind !== "tool" || !cell.parentCallId) return true;
      const parent = tools.get(cell.parentCallId);
      if (!parent) return true;
      parent.children.push(cell);
      return false;
    });
    this.rows = [];
    for (const row of roots) {
      const previous = this.rows.at(-1);
      if (row.cell.kind === "tool") {
        const tool = { ...row, cell: row.cell };
        if (previous?.kind === "tools") previous.tools.push(tool);
        else this.rows.push({ kind: "tools", key: row.key, tools: [tool] });
      } else this.rows.push({ kind: "cell", key: row.key, cell: row.cell });
    }
    this.keys = keys;
    this.cells = cells;
  }
}
