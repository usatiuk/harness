import { textOf, type ContentBlock, type ToolContext } from "@harness/protocol";

/** Workspace-specific destination; only opened when the inline budget is crossed. */
export interface OutputSpill {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  project(head: string): ContentBlock[];
}
export type OpenOutputSpill = (ctx: ToolContext) => OutputSpill | undefined;
export const OUTPUT_SPILL_SERVICE = "outputSpill";
const INLINE_BYTES = 16 * 1024;

/** One ordered producer at a time. Backpressure extends all the way to the writer. */
export class BoundedToolOutput {
  #inline: ContentBlock[] = [];
  #bytes = 0;
  #endsInHighSurrogate = false;
  #head = "";
  #writer: OutputSpill | undefined;
  overflow = false;

  constructor(private readonly open?: () => OutputSpill | undefined) {}

  async append(blocks: ContentBlock[]): Promise<void> {
    for (const block of blocks) {
      if (block.type === "image") {
        this.#inline.push(block);
        continue;
      }
      if (!block.text) continue;
      if (!this.overflow) {
        const first = block.text.charCodeAt(0);
        // A split surrogate pair encodes as four UTF-8 bytes, not two replacement characters.
        const joinedPair = this.#endsInHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
        const bytes = Buffer.byteLength(block.text) - (joinedPair ? 2 : 0);
        if (this.#bytes + bytes <= INLINE_BYTES) {
          this.#bytes += bytes;
          const last = block.text.charCodeAt(block.text.length - 1);
          this.#endsInHighSurrogate = last >= 0xd800 && last <= 0xdbff;
          this.#inline.push(block);
          continue;
        }
        this.overflow = true;
        const previous = textOf(this.#inline);
        const prefix = Buffer.from(previous + block.text.slice(0, INLINE_BYTES + 1));
        let end = INLINE_BYTES;
        while (end && (prefix[end]! & 0xc0) === 0x80) end--;
        this.#head = prefix.toString("utf8", 0, end);
        this.#inline = this.#inline.filter((item) => item.type === "image");
        this.#writer = this.open?.();
        if (previous) await this.#writer?.write(previous);
      }
      await this.#writer?.write(block.text);
    }
  }

  async finish(): Promise<ContentBlock[]> {
    if (!this.overflow) return this.#inline;
    await this.#writer?.close();
    const head = this.#writer?.project(this.#head) ?? [
      { type: "text" as const, text: this.#head },
      { type: "text" as const, text: "…[truncated]" },
    ];
    return [...head, ...this.#inline];
  }
}
