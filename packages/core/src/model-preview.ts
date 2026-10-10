import type { ModelOutputItem, ModelStreamEvent } from "@harness/protocol";

/** One normalized visible block is open at a time; adapters own native framing. */
export class ModelPreview {
  #pending: { type: "message" | "reasoning"; text: string; phase?: string | null } | undefined;

  accept(event: ModelStreamEvent): void {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const type = event.type === "text_delta" ? "message" : "reasoning";
      if (this.#pending && this.#pending.type !== type) {
        throw new Error("provider started another visible block before finalizing its preview");
      }
      this.#pending ??= { type, text: "" };
      this.#pending.text += event.text;
      if (event.type === "text_delta" && event.phase !== undefined) {
        this.#pending.phase = event.phase;
      }
    } else if (event.type === "message" || event.type === "reasoning") {
      if (this.#pending && this.#pending.type !== event.type) {
        throw new Error("provider finalized output out of normalized emission order");
      }
      this.#pending = undefined;
    } else if (this.#pending && event.type === "tool_call") {
      throw new Error("provider emitted output before finalizing its visible preview");
    }
  }

  assertFinalized(): void {
    if (this.#pending) throw new Error("provider completed with an unfinalized visible preview");
  }

  /** Partial display text has no valid native signature or replay payload. */
  takePartial(): ModelOutputItem | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending?.text) return undefined;
    const content = [{ type: "text" as const, text: pending.text }];
    return pending.type === "reasoning"
      ? { type: "reasoning", content }
      : {
          type: "message",
          content,
          ...(pending.phase !== undefined ? { phase: pending.phase } : {}),
        };
  }
}
