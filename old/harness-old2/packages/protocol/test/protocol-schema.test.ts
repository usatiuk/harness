import { describe, expect, test } from "vitest";
import {
    agentRunRecordSchema,
    contextBuildSchema,
    conversationItemSchema,
    modelFinalResponseSchema,
    modelStreamEventSchema,
    profileConfigSchema,
    providerPayloadSchema,
} from "../src/index.ts";

describe("protocol schemas", () => {
    test("applies profile and model defaults", () => {
        expect(profileConfigSchema.parse({})).toEqual({
            model: { provider: "fake", modelId: "fake-text" },
            promptFragments: [],
        });
    }, 5000);

    test("validates typed conversation message items", () => {
        expect(
            conversationItemSchema.parse({
                id: "item_1",
                conversationId: "conv_1",
                sequence: 1,
                type: "message",
                role: "user",
                status: "complete",
                content: [{ type: "text", text: "hello" }],
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toMatchObject({
            type: "message",
            role: "user",
        });
        expect(() =>
            conversationItemSchema.parse({
                id: "item_1",
                conversationId: "conv_1",
                sequence: 1,
                type: "message",
                status: "complete",
                content: [{ type: "text", text: "hello" }],
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toThrow();
    }, 5000);

    test("validates non-message conversation item types", () => {
        expect(
            conversationItemSchema.parse({
                id: "item_2",
                conversationId: "conv_1",
                sequence: 2,
                type: "compaction",
                summary: [{ type: "text", text: "summary" }],
                coversThroughItemSequence: 1,
                policyId: "deterministic-v0",
                tokenEstimate: 2,
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toMatchObject({ type: "compaction" });
        expect(
            conversationItemSchema.parse({
                id: "item_3",
                conversationId: "conv_1",
                sequence: 3,
                type: "model_error",
                runId: "run_1",
                message: "provider down",
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toMatchObject({ type: "model_error" });
    }, 5000);

    test("validates final response provider identity", () => {
        expect(
            modelFinalResponseSchema.parse({
                assistant: { content: [{ type: "text", text: "done" }] },
                providerResponse: {
                    provider: "openai",
                    modelId: "gpt-test",
                    requestId: "req_1",
                    responseId: "resp_1",
                },
            }),
        ).toEqual({
            assistant: {
                content: [{ type: "text", text: "done" }],
            },
            providerResponse: {
                provider: "openai",
                modelId: "gpt-test",
                requestId: "req_1",
                responseId: "resp_1",
            },
        });
    }, 5000);

    test("validates model stream events", () => {
        expect(
            modelStreamEventSchema.parse({
                type: "text_delta",
                delta: "hello",
            }),
        ).toEqual({ type: "text_delta", delta: "hello" });
        expect(() =>
            modelStreamEventSchema.parse({ type: "completed" }),
        ).toThrow();
        expect(() =>
            modelStreamEventSchema.parse({
                type: "unsupported",
            }),
        ).toThrow();
    }, 5000);

    test("validates provider payload version", () => {
        expect(() =>
            providerPayloadSchema.parse({
                id: "ppay_1",
                conversationId: "conv_1",
                itemId: "item_1",
                itemSequence: 1,
                provider: "fake",
                modelId: "recording",
                type: "fake.payload",
                version: 0,
                payload: {},
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toThrow();
    }, 5000);

    test("requires context build selected item sequences to be positive", () => {
        expect(() =>
            contextBuildSchema.parse({
                id: "ctx_1",
                conversationId: "conv_1",
                runId: "run_1",
                modelConfig: {
                    provider: "fake",
                    modelId: "fake-text",
                },
                selectedItemIds: ["item_1"],
                selectedItemSequences: [0],
                createdAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toThrow();
    }, 5000);

    test("requires agent runs to start at nonnegative item sequence", () => {
        expect(() =>
            agentRunRecordSchema.parse({
                id: "run_1",
                conversationId: "conv_1",
                status: "running",
                startedThroughItemSequence: -1,
                modelConfig: {
                    provider: "fake",
                    modelId: "fake-text",
                },
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            }),
        ).toThrow();
    }, 5000);
});
