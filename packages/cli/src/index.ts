import { createInterface } from "node:readline";
import { isKernelEvent, type Plugin } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { approvalMiddleware, EchoTool } from "@harness/testkit";
import { HarnessService } from "@harness/service";
import { createOpenAIPlugin } from "@harness/openai-api";
import { DemoProvider } from "./demo-provider.ts";
import { renderEvent } from "./render.ts";

const BANNER =
  "harness — type to send (steers a running turn); `> ` queues; `! ` interrupts " +
  "(bare `!` or Esc aborts); /tick = external input; /exit to quit.\n";

/** Composition root: wires the store, a model plugin, and an event-driven REPL. */
export async function run(): Promise<void> {
  const store = new InMemoryStore();

  // Real backend when an API key is present; otherwise the offline demo provider.
  const apiKey = process.env.OPENAI_API_KEY;
  const modelPlugin: Plugin = apiKey
    ? createOpenAIPlugin({ apiKey })
    : { id: "demo", providers: () => [new DemoProvider()] };
  const model = apiKey
    ? { provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-5.1" }
    : { provider: "demo", model: "demo-1" };

  const service = new HarnessService({
    store,
    plugins: [
      modelPlugin,
      { id: "tools", tools: () => [new EchoTool()] },
      // Demo: gate the echo tool through the request/respond seam (answer y/n).
      {
        id: "approval",
        toolMiddleware: () => [approvalMiddleware((call) => call.name === "echo")],
      },
    ],
  });

  // Liveness from turn.status (not from blocking on a send), so it tracks turns
  // from any source — including the /tick external one.
  let busy = false;
  // Request a middleware is parked on; a typed line answers it instead of sending.
  let pendingRequestId: string | undefined;
  service.subscribe((event) => {
    renderEvent(event);
    if (!isKernelEvent(event)) return;
    if (event.type === "turn.status") {
      busy = event.status === "running";
      if (!busy) pendingRequestId = undefined; // a parked request can't outlive its turn
    }
    if (event.type === "request.created") pendingRequestId = event.requestId;
    if (event.type === "request.resolved") pendingRequestId = undefined;
  });

  const conversation = await service.createConversation({
    instructions: "You are a helpful coding agent.",
    model,
  });

  // Codex-style input syntax → intent: `>` queue, `!` interrupt, plain steers when
  // busy else sends.
  const deliverLine = (raw: string): Promise<void> => {
    if (raw.startsWith(">")) return service.deliver(conversation.id, raw.slice(1).trim(), "queue");
    if (raw.startsWith("!"))
      return service.deliver(conversation.id, raw.slice(1).trim(), "interrupt");
    return service.deliver(conversation.id, raw, busy ? "steer" : "send");
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\n> " });

  // Best-effort Esc-to-interrupt on a TTY (scriptable equivalent: a bare `!` line).
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string, key: { name?: string } | undefined) => {
      if (key?.name === "escape") void service.deliver(conversation.id, "", "interrupt");
    });
  }

  process.stdout.write(BANNER);
  rl.prompt();
  try {
    for await (const line of rl) {
      const raw = line.trim();
      if (raw === "/exit") break;
      // While a middleware is parked on a request, the line answers it — except `!`,
      // which still interrupts (aborting the turn cancels the parked request).
      if (pendingRequestId && !raw.startsWith("!")) {
        const decision = /^(n|no|deny)$/i.test(raw) ? "deny" : "allow";
        service.respond(conversation.id, pendingRequestId, { decision });
        rl.prompt();
        continue;
      }
      if (raw === "") {
        rl.prompt();
        continue;
      }
      if (raw === "/tick") {
        // Demo of a turn started by external activity, not by typing.
        setTimeout(() => void service.send(conversation.id, "(external tick)"), 500);
        rl.prompt();
        continue;
      }
      await deliverLine(raw);
      rl.prompt();
    }
  } finally {
    rl.close();
    await service.whenIdle(conversation.id); // drain before exit
  }
}

export { DemoProvider } from "./demo-provider.ts";
export { renderEvent } from "./render.ts";
