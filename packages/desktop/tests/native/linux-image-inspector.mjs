import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
const { WebSocket } = globalThis;
// Test-only native WebKit inspection and isolated server/store setup.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, address, value] = process.argv.slice(2);
if (mode === "seed" || mode === "cleanup") {
  const { SqliteStore } = await import("../../../store-sqlite/src/index.ts");
  if (mode === "cleanup") {
    const { readDiscovery, stopServer } = await import("../../../connections/src/node.ts");
    const owner = await readDiscovery(address);
    if (owner) await stopServer(owner);
  }
  await mkdir(address, { recursive: true, mode: 0o700 });
  const store = new SqliteStore(join(address, "store.db"));
  try {
    if (mode === "seed") {
      await writeFile(
        join(address, "settings.json"),
        JSON.stringify({
          version: 1,
          model: { provider: "fixture", model: "vision" },
          providers: {
            fixture: {
              type: "openai-completions-compatible",
              config: {
                endpoint: `http://127.0.0.1:${value}/v1`,
                apiKey: "test-only",
                models: { vision: { supportsImages: true } },
              },
            },
          },
        }),
      );
      const conversation = await store.createConversation({
        workspaceRoot: address,
        overrides: { model: { provider: "fixture", model: "vision" } },
      });
      await store.updateConversationTitle(conversation.id, "Native image probe", null);
      const turn = await store.createTurn(conversation.id);
      await store.appendItem({
        conversationId: conversation.id,
        turnId: turn.id,
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Native image probe" }],
      });
      await store.updateTurn(turn.id, "completed");
    } else {
      const page = await store.listConversations();
      const items = (await Promise.all(page.map((c) => store.listOwnedItems(c.id)))).flat();
      const images = items
        .filter((i) => i.type === "message" && i.role === "user")
        .flatMap((i) => i.content.filter((b) => b.type === "image"));
      console.log(JSON.stringify({ persistedImages: images.length }));
      if (value !== undefined && images.length !== Number(value))
        throw new Error("Native image persistence count mismatch");
    }
  } finally {
    store.close();
  }
} else if (mode === "evaluate") {
  const socket = new WebSocket(address);
  const timer = setTimeout(() => {
    console.error("Inspector evaluation timed out");
    process.exit(2);
  }, 5000);
  let target;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (
      message.method === "Target.targetCreated" &&
      message.params.targetInfo.type === "page" &&
      !target
    ) {
      target = message.params.targetInfo.targetId;
      socket.send(
        JSON.stringify({
          id: 11,
          method: "Target.sendMessageToTarget",
          params: {
            targetId: target,
            message: JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression: value, returnByValue: true },
            }),
          },
        }),
      );
    } else if (message.method === "Target.dispatchMessageFromTarget") {
      const response = JSON.parse(message.params.message);
      if (response.id === 1 && message.params.targetId === target) {
        clearTimeout(timer);
        console.log(JSON.stringify(response));
        socket.close();
      }
    } else if (message.error) console.error(JSON.stringify(message));
  });
  socket.addEventListener("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
} else throw new Error("Expected seed, cleanup, or evaluate mode");
