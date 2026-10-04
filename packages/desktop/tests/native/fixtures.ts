import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqliteStore } from "@harness/store-sqlite";

export async function seedHistory(home: string, workspace: string) {
  const store = new SqliteStore(join(home, "store.db"));
  try {
    const conversation = await store.createConversation({
      workspaceRoot: workspace,
      overrides: {
        model: { provider: "demo", model: "demo-1", preset: "high" },
        instructions: "Be helpful.",
      },
    });
    const turn = await store.createTurn(conversation.id);
    for (let index = 0; index < 1100; index++)
      await store.appendItem({
        conversationId: conversation.id,
        turnId: turn.id,
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: `History ${index}: ${"representative coding discussion ".repeat(10)}`,
          },
        ],
      });
    await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "tool_call",
      callId: "edit-fixture",
      name: "edit",
      args: {
        path: "greeting.ts",
        old_string: "const greeting = 'before';",
        new_string: "const greeting = 'after';",
      },
    });
    await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "tool_result",
      callId: "edit-fixture",
      status: "ok",
      content: [
        {
          type: "text",
          text: `large-output-start\n${"representative output line\n".repeat(10000)}large-output-end`,
        },
      ],
    });
    await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "**History loaded.**\n\n```typescript\nconst greeting = 'after';\n```",
        },
      ],
    });
    await store.updateTurn(turn.id, "completed");
    for (let index = 0; index < 55; index++)
      await store.createConversation({
        workspaceRoot: workspace,
        overrides: { model: { provider: "demo", model: "demo-1" } },
      });
    return conversation.id;
  } finally {
    store.close();
  }
}

export async function seedChildOnlyPages(home: string, workspace: string) {
  let createdAt = 0;
  const store = new SqliteStore(join(home, "store.db"), undefined, { now: () => ++createdAt });
  try {
    const overrides = { model: { provider: "demo", model: "demo-1" } };
    const root = await store.createConversation({ workspaceRoot: workspace, overrides });
    for (let index = 0; index < 150; index++) {
      const child = await store.createConversation({ workspaceRoot: workspace, overrides });
      await store.putPluginState("subagents", child.id, "spawn", { parentConversationId: root.id });
    }
    return root.id;
  } finally {
    store.close();
  }
}

/** Substitute only the model network edge; the app/server/tool/process stack is real. */
export async function commandProvider(
  home: string,
  command: string,
  options: { reviewer?: boolean } = {},
) {
  const reviews: Array<{ model: string; temperature?: number }> = [];
  let invocation = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const data = JSON.parse(body) as {
        model: string;
        temperature?: number;
        messages: Array<{ role: string }>;
      };
      const reviewing = data.model === "reviewer" || data.model === "reviewer-fast";
      if (reviewing) reviews.push(data);
      const toolFinished = data.messages.at(-1)?.role === "tool";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = reviewing
        ? { content: "YES" }
        : toolFinished
          ? {
              content: options.reviewer
                ? "Command completed."
                : "Command is running in the background.",
            }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `command-${++invocation}`,
                  type: "function",
                  function: {
                    name: "powershell",
                    arguments: JSON.stringify({ command, background: !options.reviewer }),
                  },
                },
              ],
            };
      const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({
        id: "completion",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      });
      emit({
        id: "completion",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [
          { index: 0, delta: {}, finish_reason: toolFinished || reviewing ? "stop" : "tool_calls" },
        ],
      });
      emit({
        id: "completion",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model fixture did not listen");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      model: { provider: "fixture", model: "test-model" },
      providers: {
        fixture: {
          type: "openai-completions-compatible",
          config: {
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test-only",
            models: {
              "test-model": {},
              ...(options.reviewer
                ? {
                    reviewer: { presets: { careful: { temperature: 0.1 } } },
                    "reviewer-fast": { presets: { quick: { temperature: 0.5 } } },
                  }
                : {}),
            },
          },
        },
      },
      plugins: {
        approval: {
          inWorkspace: options.reviewer ? "ask" : "allow",
          outOfWorkspace: options.reviewer ? "ask" : "allow",
        },
      },
    }),
  );
  return {
    reviews,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
