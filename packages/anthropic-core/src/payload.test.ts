import { describe, expect, it } from "vitest";
import type { ProviderPayload } from "@harness/protocol";
import { encodeThinkingPayload, readThinkingPayload } from "./payload.ts";

const base = (): ProviderPayload => ({
  itemId: "i" as ProviderPayload["itemId"],
  ...encodeThinkingPayload(
    { kind: "thinking", thinking: "t", signature: "s" },
    "anthropic",
    "claude-x",
  ),
});

describe("thinking payload replay gating", () => {
  it("reads back on an exact provider/model/type/version match", () => {
    expect(readThinkingPayload(base(), "anthropic", "claude-x")).toEqual({
      kind: "thinking",
      thinking: "t",
      signature: "s",
    });
  });

  it("drops on a provider, model, or version mismatch", () => {
    expect(readThinkingPayload(base(), "anthropic-oauth", "claude-x")).toBeUndefined();
    expect(readThinkingPayload(base(), "anthropic", "claude-y")).toBeUndefined();
    expect(readThinkingPayload({ ...base(), version: 2 }, "anthropic", "claude-x")).toBeUndefined();
    expect(readThinkingPayload(undefined, "anthropic", "claude-x")).toBeUndefined();
  });
});
