import { describe, expect, it } from "vitest";
import { mistralAPIProviderType, mistralVibeProviderType } from "./index.ts";

for (const type of [mistralAPIProviderType, mistralVibeProviderType]) {
  describe(`${type.type} configured models`, () => {
    it("accepts exact IDs with optional metadata", () => {
      expect(() =>
        type.prepare({
          models: {
            "manual-model": { label: "Manual", contextWindow: 262144, maxOutputTokens: 8192 },
            "another-model": {},
          },
        }),
      ).not.toThrow();
    });

    it.each([
      { contextWindow: 0 },
      { contextWindow: 1.5 },
      { maxOutputTokens: -1 },
      { contextWindow: 1024, maxOutputTokens: 2048 },
      { label: " " },
      { context_size: 1024 },
      { presets: { high: {} } },
    ])("rejects invalid metadata %j", (model) => {
      expect(() => type.prepare({ models: { manual: model } })).toThrow();
    });

    it("rejects blank/oversized IDs and too many entries", () => {
      for (const id of ["", " ", "x".repeat(513)])
        expect(() => type.prepare({ models: { [id]: {} } })).toThrow();
      const models = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`model-${i}`, {}]));
      expect(() => type.prepare({ models })).toThrow("exceeds 5000 models");
    });
  });
}
