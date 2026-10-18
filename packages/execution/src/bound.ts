/**
 * Bounds a blob to a readable window for the model. Byte-aware: each line is capped before head/tail
 * selection, so a single multi-megabyte line can't blow the budget. The full bytes live elsewhere.
 */
export interface BoundOptions {
  /** Max lines to keep after selection. */
  maxLines: number;
  /** Max bytes per line; longer lines are cut at a UTF-8 boundary with a `…[+N bytes]` marker. */
  maxLineBytes: number;
  /** Hard ceiling on the rendered string's bytes; trims from the non-anchored end. */
  maxTotalBytes: number;
  /** Keep the first (`head`) or last (`tail`) lines. */
  mode: "head" | "tail";
  /** Optional JS regex (source) filter applied per line before selection. */
  filter?: string;
}

/** Cuts `line` to at most `maxBytes` UTF-8 bytes (never mid-codepoint), marking the elision. */
function capLine(line: string, maxBytes: number): string {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= maxBytes) return line;
  let end = maxBytes;
  // Back off any UTF-8 continuation bytes (0b10xxxxxx) so we never split a codepoint.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}…[+${buf.length - end} bytes]`;
}

export function boundView(text: string, opts: BoundOptions): string {
  let lines = text.split("\n").map((l) => capLine(l, opts.maxLineBytes));
  if (opts.filter) {
    const re = new RegExp(opts.filter);
    lines = lines.filter((l) => re.test(l));
  }
  const omitted = Math.max(0, lines.length - opts.maxLines);
  if (omitted > 0) {
    lines =
      opts.mode === "tail"
        ? lines.slice(lines.length - opts.maxLines)
        : lines.slice(0, opts.maxLines);
    const marker = `…[${omitted} more lines]`;
    if (opts.mode === "tail") lines.unshift(marker);
    else lines.push(marker);
  }
  let out = lines.join("\n");
  // Final byte ceiling: trim from the end the anchor doesn't protect, backing off continuation
  // bytes (0b10xxxxxx) so the cut never lands mid-codepoint.
  if (Buffer.byteLength(out, "utf8") > opts.maxTotalBytes) {
    const buf = Buffer.from(out, "utf8");
    if (opts.mode === "tail") {
      let start = buf.length - opts.maxTotalBytes;
      while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
      out = `…${buf.subarray(start).toString("utf8")}`;
    } else {
      let end = opts.maxTotalBytes;
      while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
      out = `${buf.subarray(0, end).toString("utf8")}…`;
    }
  }
  return out;
}

/** Default model-facing command view: a 40-line tail under a 16 KiB ceiling. */
export const COMMAND_VIEW_DEFAULT_LINES = 40;
export const COMMAND_VIEW_DEFAULT_BYTES = 16 * 1024;
/**
 * Hard caps for a widened per-command view (`max_lines`): 500 lines / 64 KiB total, keeping
 * headroom under `read_file`'s 256 KiB window.
 */
export const COMMAND_VIEW_MAX_LINES = 500;
export const COMMAND_VIEW_MAX_BYTES = 64 * 1024;

/**
 * Resolves the `boundView` options for one command activity: the default 40-line/16 KiB tail, or
 * a wider tail when the caller passes `max_lines`. Over-cap requests clamp to the hard caps;
 * a non-positive-integer request throws (the tool schema rejects it at the wire first, so this
 * only fires on direct programmatic misuse).
 */
export function resolveCommandView(maxLines?: number): BoundOptions {
  const wanted = maxLines ?? COMMAND_VIEW_DEFAULT_LINES;
  if (!Number.isInteger(wanted) || wanted <= 0) {
    throw new Error(`max_lines must be a positive integer, got ${String(maxLines)}`);
  }
  const lines = Math.min(wanted, COMMAND_VIEW_MAX_LINES);
  return {
    maxLines: lines,
    maxLineBytes: 1024,
    maxTotalBytes:
      lines <= COMMAND_VIEW_DEFAULT_LINES ? COMMAND_VIEW_DEFAULT_BYTES : COMMAND_VIEW_MAX_BYTES,
    mode: "tail",
  };
}
