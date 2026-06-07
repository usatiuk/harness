import type { ContentBlock, Event } from "@harness/protocol";

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** Renders one event by type, falling back to generic JSON for unknown types. */
export function renderEvent(event: Event): void {
  switch (event.type) {
    case "turn.status":
      process.stdout.write(`\n\x1b[2m● turn ${event.status}\x1b[0m\n`);
      return;
    case "message":
      if (event.item.type === "message" && event.item.role === "assistant") {
        process.stdout.write("\n");
      }
      return;
    case "text_delta":
      process.stdout.write(event.text);
      return;
    case "tool_call.started":
      process.stdout.write(`\x1b[36m🔧 ${event.name}(${JSON.stringify(event.args)})\x1b[0m\n`);
      return;
    case "tool_call.completed":
      process.stdout.write(`\x1b[2m   → ${textOf(event.forModel)} [${event.status}]\x1b[0m\n`);
      return;
    default:
      // Unknown event types fall back to a generic renderer so plugin data stays inspectable.
      process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
