import { createInterface } from "node:readline/promises";
import { InMemoryStore } from "@harness/store";
import { EchoTool } from "@harness/testkit";
import { HarnessService } from "@harness/service";
import { DemoProvider } from "./demo-provider.ts";
import { renderEvent } from "./render.ts";

/** Composition root: wires the store, the demo plugin, and a stdin read loop. */
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
  service.subscribe(renderEvent);

  const conversation = await service.createConversation({
    instructions: "You are a demo agent.",
    model: { provider: "demo", model: "demo-1" },
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("harness demo — type a message, or /exit to quit.\n");
  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("\n> ")).trim();
      } catch {
        break; // input stream closed (EOF)
      }
      if (line === "/exit") break;
      if (line === "") continue;
      await service.send(conversation.id, line);
    }
  } finally {
    rl.close();
  }
}

export { DemoProvider } from "./demo-provider.ts";
export { renderEvent } from "./render.ts";
