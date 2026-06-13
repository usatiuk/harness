import type Anthropic from "@anthropic-ai/sdk";
import type { NativeToolId } from "@harness/protocol";

/** The harness id for Claude's trained file editor (`str_replace_based_edit_tool`). */
export const TEXT_EDITOR_ID: NativeToolId = "anthropic.text_editor";

/** The wire descriptor (`type` + `name`) for a provider built-in; spread into the tools array. */
type NativeWire = Pick<Anthropic.Messages.ToolTextEditor20250728, "type" | "name">;

/**
 * Maps a harness `NativeToolId` to the Anthropic built-in's versioned wire descriptor. The
 * provider owns this table — the kernel ships only the opaque id, never a JSON Schema.
 */
export const NATIVE_TOOLS: Record<NativeToolId, NativeWire> = {
  [TEXT_EDITOR_ID]: { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
};
