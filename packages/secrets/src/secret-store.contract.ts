import { describe, expect, it } from "vitest";
import type { SecretStore } from "./store.ts";

/**
 * Behavioral spec every `SecretStore` must satisfy.
 */
export function secretStoreContract(name: string, makeStore: () => SecretStore): void {
  describe(name, () => {
    it("yields null for an absent key", async () => {
      expect(await makeStore().get("missing")).toBeNull();
    });

    it("round-trips a stored secret", async () => {
      const store = makeStore();
      await store.set("k", "v");
      expect(await store.get("k")).toBe("v");
    });

    it("overwrites an existing secret", async () => {
      const store = makeStore();
      await store.set("k", "v1");
      await store.set("k", "v2");
      expect(await store.get("k")).toBe("v2");
    });

    it("delete removes a secret and reports whether one existed", async () => {
      const store = makeStore();
      await store.set("k", "v");
      expect(await store.delete("k")).toBe(true);
      expect(await store.get("k")).toBeNull();
      expect(await store.delete("k")).toBe(false);
    });
  });
}
