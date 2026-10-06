import type { Cell } from "@harness/client-features/transcript-reducer";

export interface TranscriptRow {
  key: string;
  cell: Cell;
  children: Cell[];
}

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
    const rows: TranscriptRow[] = [];
    const tools = new Map<string, TranscriptRow>();
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
      const row = { key, cell, children: [] } satisfies TranscriptRow;
      rows.push(row);
      if (cell.kind === "tool") tools.set(cell.callId, row);
    }
    this.rows = rows.filter((row) => {
      const cell = row.cell;
      if (cell.kind !== "tool" || !cell.parentCallId) return true;
      const parent = tools.get(cell.parentCallId);
      if (!parent) return true;
      parent.children.push(cell);
      return false;
    });
    this.keys = keys;
    this.cells = cells;
  }
}
