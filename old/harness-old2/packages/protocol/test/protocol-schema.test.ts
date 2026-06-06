import { describe, expect, test } from "vitest";
import {
  agentRunRecordSchema,
  contextBuildSchema,
  conversationItemSchema,
  modelStepResultSchema,
  profileConfigSchema,
  providerStateSchema
} from "../src/index.ts";

describe("protocol schemas", () => {
  test("applies profile and model defaults", () => {
    expect(profileConfigSchema.parse({})).toEqual({
      model: { provider: "fake", adapter: "fake", modelId: "fake-text" },
      promptFragments: []
    });
  }, 5000);

  test("rejects invalid conversation item sequence and visibility", () => {
    expect(() => conversationItemSchema.parse({
      id: "item_1",
      conversationId: "conv_1",
      sequence: 0,
      class: "transcript",
      kind: "user_message",
      role: "user",
      visibility: "hidden",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  }, 5000);

  test("defaults model step provider events and metadata", () => {
    expect(modelStepResultSchema.parse({
      content: [{ type: "text", text: "done" }]
    })).toEqual({
      content: [{ type: "text", text: "done" }],
      providerEvents: [],
      metadata: {}
    });
  }, 5000);

  test("validates provider state cursors and payload version", () => {
    expect(() => providerStateSchema.parse({
      id: "pstate_1",
      conversationId: "conv_1",
      provider: "fake",
      adapter: "recording",
      modelId: "recording",
      payloadVersion: 0,
      payload: {},
      producedThroughItemSequence: 1,
      referencedItemSequences: [1],
      createdAt: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  }, 5000);

  test("requires context build selected item sequences to be positive", () => {
    expect(() => contextBuildSchema.parse({
      id: "ctx_1",
      conversationId: "conv_1",
      runId: "run_1",
      modelConfig: { provider: "fake", adapter: "fake", modelId: "fake-text" },
      selectedItemIds: ["item_1"],
      selectedItemSequences: [0],
      createdAt: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  }, 5000);

  test("requires agent runs to start at nonnegative item sequence", () => {
    expect(() => agentRunRecordSchema.parse({
      id: "run_1",
      conversationId: "conv_1",
      status: "running",
      startedThroughItemSequence: -1,
      modelConfig: { provider: "fake", adapter: "fake", modelId: "fake-text" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })).toThrow();
  }, 5000);
});
