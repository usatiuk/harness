import { createInterface } from "node:readline";
import { isKernelEvent } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { EchoTool } from "@harness/testkit";
import { HarnessService } from "@harness/service";
import { DemoProvider } from "./demo-provider.ts";
import { renderEvent } from "./render.ts";

const BANNER =
  "harness demo — type to send (steers a running turn); `> ` queues; `! ` interrupts " +
  "(bare `!` or Esc aborts); /tick = external input; /exit to quit.\n";

/** Composition root: wires the store, the demo plugin, and an event-driven REPL. */
export async function run(): Promise<void> {
  const store = new InMemoryStore();
  const service = new HarnessService({
    store,
    plugins: [
      {
        id: "demo",
        providers: () => [new DemoProvider()],
        tools: () => [new EchoTool()],
      },
    ],
  });

  // Liveness from turn.status (not from blocking on a send), so it tracks turns
  // from any source — including the /tick external one.
  let busy = false;
  service.subscribe((event) => {
    renderEvent(event);
    if (isKernelEvent(event) && event.type === "turn.status") {
      busy = event.status === "running";
    }
  });

  const conversation = await service.createConversation({
    instructions: "You are a demo agent.",
    model: { provider: "demo", model: "demo-1" },
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
