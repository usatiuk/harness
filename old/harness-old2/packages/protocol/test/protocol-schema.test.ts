import { describe, expect, test } from "vitest";
import {
  agentRunRecordSchema,
  contextBuildSchema,
  conversationItemSchema,
  modelFinalResponseSchema,
  modelStreamEventSchema,
  profileConfigSchema,
  providerEncodingSchema
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

  test("defaults model final response assistant metadata", () => {
    expect(modelFinalResponseSchema.parse({
      assistant: { content: [{ type: "text", text: "done" }] }
    })).toEqual({
      assistant: {
        content: [{ type: "text", text: "done" }],
        metadata: {}
      }
    });
  }, 5000);

  test("validates model stream events", () => {
    expect(modelStreamEventSchema.parse({ type: "text_delta", delta: "hello" })).toEqual({ type: "text_delta", delta: "hello" });
    expect(() => modelStreamEventSchema.parse({ type: "completed" })).toThrow();
  }, 5000);

  test("validates provider encoding format version", () => {
    expect(() => providerEncodingSchema.parse({
      id: "penc_1",
      conversationId: "conv_1",
      itemId: "item_1",
      itemSequence: 1,
      provider: "fake",
      adapter: "recording",
      modelId: "recording",
      format: "fake.encoding",
      formatVersion: 0,
      payload: {},
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
