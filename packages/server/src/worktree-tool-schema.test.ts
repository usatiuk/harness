import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import { MemorySecretStore } from "@harness/secrets";
import { parseSettingsDoc } from "@harness/config";
import { textStep } from "@harness/testkit";
import type { ModelRequest } from "@harness/protocol";

// Shell startup is unrelated to tool assembly and belongs to its OS integration suite.
vi.mock("@harness/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@harness/execution")>()),
  initializeUserShellEnvironment: vi.fn(async () => {}),
}));
import { buildServerHarness } from "./index.ts";
import { DemoProvider } from "./demo-provider.ts";
import { providerEntries } from "./auth.ts";

it.each(["anthropic-api", "litellm"] as const)(
  "serializes the assembled worktree tool as a flat object through %s",
  async (type) => {
    const home = await mkdtemp(join(tmpdir(), "harness-worktree-schema-"));
    vi.stubEnv("HARNESS_HOME", home);
    vi.stubEnv("HARNESS_SERVER_SELECTION", undefined);
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
      vi.stubEnv(key, "");
    const requests: ModelRequest[] = [];
    vi.spyOn(DemoProvider.prototype, "stream").mockImplementation(async function* (request) {
      if (request.tools?.some((tool) => tool.name === "worktree_switch")) requests.push(request);
      yield* textStep("done");
    });
    const pair = createInProcessMessageConnectionPair();
    const harness = await buildServerHarness(pair.right);
    try {
      const conversation = await harness.service.createConversation({
        overrides: {
          model: { provider: "demo", model: "demo-1" },
          tools: { mode: "hybrid" },
        },
      });
      await harness.service.send(conversation.id, "hello");
      await harness.service.whenIdle(conversation.id);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const model = type === "anthropic-api" ? "claude-haiku-4-5" : "gemini-test";
      vi.stubEnv("HARNESS_SCHEMA_TEST_KEY", "sk-ant-test-only");
      const config = {
        apiKey: { env: "HARNESS_SCHEMA_TEST_KEY" },
        baseUrl: "http://provider.test",
        // No LiteLLM transport override: this must exercise its default chat/completions path.
        ...(type === "litellm" ? { models: { [model]: {} } } : {}),
      };
      const bodies: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
          bodies.push({
            url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            body: JSON.parse(init.body) as Record<string, unknown>,
          });
          const events =
            type === "anthropic-api"
              ? [
                  {
                    type: "message_start",
                    message: { usage: { input_tokens: 1, output_tokens: 0 } },
                  },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 1 },
                  },
                  { type: "message_stop" },
                ]
              : [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }];
          return new Response(
            events
              .map(
                (event) =>
                  `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const provider = await providerEntries(
        new MemorySecretStore(),
        parseSettingsDoc({ providers: { fixture: { type, config } } }, "fixture"),
      )
        .get("fixture")!
        .instance.buildProvider();
      expect(provider).not.toBeNull();
      const events = [];
      for await (const event of provider!.stream(
        { ...request, modelConfig: { provider: "fixture", model } },
        new AbortController().signal,
        { conversationId: conversation.id },
      ))
        events.push(event);
      expect(events.length).toBeGreaterThan(0);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.url).toBe(
        type === "anthropic-api"
          ? "http://provider.test/v1/messages"
          : "http://provider.test/v1/chat/completions",
      );
      const assembled = request.tools!.find((tool) => tool.name === "worktree_switch")!;
      expect(assembled.kind).toBe("function");
      if (assembled.kind !== "function") throw new Error("Expected function tool");
      expect(assembled.parameters).toEqual({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["original", "new", "existing"] },
          branch: {
            type: "string",
            minLength: 1,
            description: "Optional branch name for kind new only.",
          },
          path: {
            type: "string",
            minLength: 1,
            description: "Required worktree path for kind existing only.",
          },
        },
        required: ["kind"],
        additionalProperties: false,
      });
      const wireTools = bodies[0]!.body.tools as Record<string, unknown>[];
      if (type === "anthropic-api") {
        expect(wireTools.find((tool) => tool.name === "worktree_switch")?.input_schema).toEqual(
          assembled.parameters,
        );
      } else {
        const functions = wireTools.map((tool) => tool.function as Record<string, unknown>);
        expect(functions.find((tool) => tool.name === "worktree_switch")?.parameters).toEqual(
          assembled.parameters,
        );
      }
    } finally {
      vi.unstubAllGlobals();
      await harness.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
);
