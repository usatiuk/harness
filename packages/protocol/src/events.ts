import type { ContentBlock } from "./content.ts";
import type { TurnId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ToolStatus } from "./tools.ts";
import type { TurnStatus } from "./conversation.ts";

/** Typed event stream out. Structured data with a type, never pre-rendered text. */
export type Event =
  | { type: "turn.status"; turnId: TurnId; status: TurnStatus }
  | { type: "message"; item: Item }
  | { type: "text_delta"; turnId: TurnId; text: string }
  | { type: "tool_call.started"; callId: string; name: string; args: unknown }
  | {
      type: "tool_call.completed";
      callId: string;
      status: ToolStatus;
      forModel: ContentBlock[];
    };
