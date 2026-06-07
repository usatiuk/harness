import {
  assertNever,
  isKernelEvent,
  type ContentBlock,
  type HarnessEvent,
} from "@harness/protocol";

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** Renders one event by type, falling back to generic JSON for plugin events. */
export function renderEvent(event: HarnessEvent): void {
  if (!isKernelEvent(event)) {
    // Plugin events stay inspectable without the renderer knowing their shape.
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  switch (event.type) {
    case "turn.status": {
      const detail = event.error ? `: ${event.error}` : "";
      process.stdout.write(`\n\x1b[2m● turn ${event.status}${detail}\x1b[0m\n`);
      return;
    }
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
      assertNever(event);
  }
}
