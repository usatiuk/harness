import { describe, expect, it } from "vitest";
import type { Interactions } from "@google/genai";
import type { Item, ModelRequest, ModelStreamEvent, ProviderPayload } from "@harness/protocol";
import { buildInteraction, interactionEvents } from "./provider.ts";
import { geminiProviderType } from "./index.ts";

const request = (): ModelRequest => ({
  instructions: [],
  items: [],
  prompt: "go",
  modelConfig: { provider: "gemini", model: "gemini-test" },
  providerOptions: { webSearch: true },
});
const item = (value: object): Item =>
  ({
    id: "i",
    conversationId: "c",
    turnId: "t",
    parent: null,
    seq: 0,
    createdAt: 0,
    ...value,
  }) as Item;
const payload = (value: unknown): ProviderPayload => ({
  itemId: "i" as ProviderPayload["itemId"],
  provider: "gemini",
  model: "gemini-test",
  type: "interaction_steps",
  version: 1,
  payload: value,
});
const result = (
  steps: Interactions.Step[],
  status: Interactions.Interaction["status"] = "completed",
): Interactions.Interaction => ({
  id: "interaction",
  status,
  steps,
  usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3 },
});
const history = (events: ModelStreamEvent[]): ModelRequest["items"] =>
  events.flatMap((event) =>
    event.type === "message" ||
    event.type === "reasoning" ||
    event.type === "tool_call" ||
    event.type === "provider_output"
      ? [
          {
            item: item(event.type === "message" ? { ...event, role: "assistant" } : event),
            ...(event.payload
              ? { payload: { ...event.payload, itemId: "i" as ProviderPayload["itemId"] } }
              : {}),
          },
        ]
      : [],
  );
const search: Interactions.Step[] = [
  {
    type: "google_search_call",
    id: "search",
    arguments: { queries: ["example"] },
    signature: "CALL_SIGNATURE",
  },
  { type: "google_search_result", call_id: "search", result: [], signature: "RESULT_SIGNATURE" },
];

describe("Gemini native search", () => {
  it.each([null, 1, []].map((args) => [args]))(
    "renders non-object historical arguments %j as readable text",
    (args) => {
      const params = buildInteraction({
        ...request(),
        items: [
          { item: item({ type: "tool_call", callId: "bad", name: "echo", args }) },
          {
            item: item({
              type: "tool_result",
              callId: "bad",
              status: "error",
              content: [{ type: "text", text: "expected an object" }],
            }),
          },
        ],
      });
      expect(params.input).toEqual([
        {
          type: "model_output",
          content: [{ type: "text", text: `Tool echo: ${JSON.stringify(args)}` }],
        },
        { type: "user_input", content: [{ type: "text", text: "expected an object" }] },
        { type: "user_input", content: [{ type: "text", text: "go" }] },
      ]);
    },
  );

  it("declares provider-owned search and forwards toolChoice independently", () => {
    expect(geminiProviderType.configSchema.parse({})).toMatchObject({ webSearch: true });
    expect(buildInteraction(request())).toMatchObject({
      store: false,
      tools: [{ type: "google_search" }],
    });
    expect(buildInteraction({ ...request(), toolChoice: "none" })).toMatchObject({
      tools: [{ type: "google_search" }],
      generation_config: { tool_choice: "none" },
    });
    expect(buildInteraction({ ...request(), providerOptions: { webSearch: false } }).tools).toEqual(
      [],
    );
    expect(buildInteraction(request(), true).generation_config?.thinking_summaries).toBe("auto");
  });

  it("ignores display hints even when they have historical metadata", () => {
    const params = buildInteraction({
      ...request(),
      items: [
        {
          item: item({
            type: "provider_output",
            content: [{ type: "text", text: "Searched SECRET" }],
          }),
          payload: payload(search),
        },
      ],
    });
    expect(params.input).toEqual([{ type: "user_input", content: [{ type: "text", text: "go" }] }]);
    expect(JSON.stringify(params)).not.toContain("SECRET");
    expect(JSON.stringify(params)).not.toContain("SIGNATURE");
  });

  it("round-trips finalized native context without making search executable", () => {
    const steps: Interactions.Step[] = [
      {
        type: "thought",
        summary: [{ type: "text", text: "reason" }],
        signature: "THOUGHT_SIGNATURE",
      },
      ...search,
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: "[Source](https://example.com)",
            annotations: [
              { type: "url_citation", url: "https://example.com", start_index: 0, end_index: 6 },
            ],
          },
        ],
      },
    ];
    const events = [...interactionEvents(result(steps), request())];
    expect(events.map((event) => event.type)).toEqual([
      "reasoning",
      "provider_output",
      "message",
      "completed",
    ]);
    expect(events[0]).toMatchObject({ content: [{ type: "text", text: "reason" }] });
    expect(events[1]).toEqual({
      type: "provider_output",
      content: [{ type: "text", text: "Searched example." }],
    });
    expect(events[2]).toMatchObject({
      content: [{ type: "text", text: "[Source](https://example.com)" }],
      payload: { payload: steps.slice(1) },
    });
    expect(events[3]).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 8 },
      costIncomplete: true,
      inputTokensAreContext: false,
    });
    const items = history(events);
    expect(buildInteraction({ ...request(), items }).input).toEqual([
      ...steps,
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
    expect(buildInteraction({ ...request(), items: items.slice(0, 1) }).input).toEqual([
      steps[0],
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
    expect(
      buildInteraction({ ...request(), items, modelConfig: { provider: "other", model: "other" } })
        .input,
    ).toEqual([
      { type: "model_output", content: [{ type: "text", text: "[Source](https://example.com)" }] },
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
  });
  it("keeps completed search history across readable output and removes unmatched selected prefixes", () => {
    const steps: Interactions.Step[] = [
      search[0]!,
      { type: "thought", summary: [{ type: "text", text: "Searching" }], signature: "THOUGHT" },
      search[1]!,
      { type: "model_output", content: [{ type: "text", text: "Answer" }] },
    ];
    const items = history([...interactionEvents(result(steps), request())]);
    expect(buildInteraction({ ...request(), items }).input).toEqual([
      ...steps,
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
    expect(buildInteraction({ ...request(), items: items.slice(0, 2) }).input).toEqual([
      steps[1],
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
  });

  it("discards incomplete native state and continuation tokens while preserving text and usage", () => {
    const events = [
      ...interactionEvents(
        {
          ...result(
            [search[0]!, { type: "model_output", content: [{ type: "text", text: "partial" }] }],
            "incomplete",
          ),
          continuation_token: "DO_NOT_RESUME",
        },
        request(),
      ),
    ];
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      error: "Gemini interaction stopped: incomplete",
      usage: { inputTokens: 10, outputTokens: 8 },
    });
    expect(events.every((event) => !("payload" in event))).toBe(true);
    const params = buildInteraction({ ...request(), items: history(events) });
    expect(JSON.stringify(params)).not.toContain("DO_NOT_RESUME");
    expect(JSON.stringify(params)).not.toContain("google_search_call");
    expect(params).not.toHaveProperty("continuation_token");
    expect(params).not.toHaveProperty("previous_interaction_id");
    expect(events.at(-1)).not.toHaveProperty("requiresContinuation");
  });

  it("retains trailing completed search history on the last finalized item", () => {
    const steps: Interactions.Step[] = [
      { type: "model_output", content: [{ type: "text", text: "answer" }] },
      ...search,
    ];
    const events = [...interactionEvents(result(steps), request())];
    expect(buildInteraction({ ...request(), items: history(events) }).input).toEqual([
      ...steps,
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
  });
  it("retains a completed search-only response on an empty ordinary message", () => {
    const events = [...interactionEvents(result(search), request())];
    expect(events.map((event) => event.type)).toEqual(["provider_output", "message", "completed"]);
    expect(events[1]).toMatchObject({ type: "message", content: [], payload: { payload: search } });
    expect(buildInteraction({ ...request(), items: history(events) }).input).toEqual([
      ...search,
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
  });

  it("maps only local functions to executable calls and their matching result", () => {
    const call: Interactions.Step = {
      type: "function_call",
      id: "local",
      name: "echo",
      arguments: { x: 1 },
    };
    const events = [...interactionEvents(result([...search, call], "requires_action"), request())];
    expect(events[1]).toMatchObject({
      type: "tool_call",
      callId: "local",
      name: "echo",
      args: { x: 1 },
    });
    expect(events.at(-1)).not.toHaveProperty("error");
    const items = [
      ...history(events),
      {
        item: item({
          type: "tool_result",
          callId: "local",
          status: "ok",
          content: [{ type: "text", text: "echoed" }],
        }),
      },
    ];
    expect(buildInteraction({ ...request(), items }).input).toEqual([
      ...search,
      call,
      { type: "function_result", call_id: "local", result: "echoed", is_error: false },
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
    const unfinished = [...interactionEvents(result([search[0]!], "requires_action"), request())];
    expect(unfinished.at(-1)).toMatchObject({
      type: "completed",
      error: "Gemini interaction stopped: requires_action",
    });
  });

  it("drops an unanswered search beside a completed local-call response", () => {
    const call: Interactions.Step = {
      type: "function_call",
      id: "local",
      name: "echo",
      arguments: {},
    };
    const events = [...interactionEvents(result([search[0]!, call], "requires_action"), request())];
    expect(events.at(-1)).not.toHaveProperty("error");
    const params = buildInteraction({
      ...request(),
      toolChoice: "none",
      items: [
        ...history(events),
        {
          item: item({
            type: "tool_result",
            callId: "local",
            status: "ok",
            content: [{ type: "text", text: "echoed" }],
          }),
        },
      ],
    });
    expect(params.input).toEqual([
      call,
      { type: "function_result", call_id: "local", result: "echoed", is_error: false },
      { type: "user_input", content: [{ type: "text", text: "go" }] },
    ]);
    expect(JSON.stringify(params)).not.toContain("google_search_call");
  });

  it("fails unsupported output without saving hidden native content", () => {
    const events = [
      ...interactionEvents(
        result([
          {
            type: "model_output",
            content: [{ type: "image", data: "PIXELS", mime_type: "image/png" }],
          },
        ]),
        request(),
      ),
    ];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "completed",
      error: "Gemini returned unsupported non-text output",
      usage: { inputTokens: 10, outputTokens: 8 },
    });
  });
  it("preserves readable text in unsupported mixed output without native metadata", () => {
    const events = [
      ...interactionEvents(
        result([
          {
            type: "model_output",
            content: [
              { type: "text", text: "Received text" },
              { type: "image", data: "PIXELS", mime_type: "image/png" },
            ],
          },
        ]),
        request(),
      ),
    ];
    expect(events).toEqual([
      { type: "message", content: [{ type: "text", text: "Received text" }] },
      {
        type: "completed",
        usage: { inputTokens: 10, outputTokens: 8, cachedReadTokens: 0 },
        providerUsage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3 },
        error: "Gemini returned unsupported non-text output",
      },
    ]);
  });
});
