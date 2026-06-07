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
      // green running/completed, yellow aborted, red failed.
      const colour = event.status === "failed" ? "31" : event.status === "aborted" ? "33" : "32";
      process.stdout.write(`\n\x1b[${colour}m● turn ${event.status}${detail}\x1b[0m\n`);
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
    case "reasoning_delta":
      process.stdout.write(`\x1b[2m${event.text}\x1b[0m`); // dim
      return;
    case "reasoning":
      process.stdout.write("\n");
      return;
    case "compaction":
      process.stdout.write("\n\x1b[2m✦ context compacted\x1b[0m\n");
      return;
    case "tool_call.started":
      process.stdout.write(`\x1b[36m🔧 ${event.name}(${JSON.stringify(event.args)})\x1b[0m\n`);
      return;
    case "tool_call.completed":
      process.stdout.write(`\x1b[2m   → ${textOf(event.forModel)} [${event.status}]\x1b[0m\n`);
      return;
    case "request.created": {
      const req = event.request as { kind?: string; call?: { name?: string } };
      const prompt =
        req.kind === "approval"
          ? `approve ${req.call?.name}? [y/n]`
          : JSON.stringify(event.request);
      process.stdout.write(`\n\x1b[35m❓ ${prompt}\x1b[0m\n`);
      return;
    }
    case "request.resolved":
      return;
    default:
      assertNever(event);
  }
}
