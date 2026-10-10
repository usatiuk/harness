import { MemorySecretStore } from "@harness/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerEntries, authRegistry, type AuthEntry } from "./auth.ts";

const entryOf = (reg: Map<string, AuthEntry>, id: string): AuthEntry => {
  const entry = reg.get(id);
  if (!entry) throw new Error(`missing entry: ${id}`);
  return entry;
};

describe("authRegistry", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_VIBE_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("exposes the known providers", () => {
    expect([...authRegistry(new MemorySecretStore()).keys()]).toEqual([
      "openai",
      "anthropic",
      "opencode-go",
      "openai-codex",
      "mistral-api",
      "mistral-vibe",
    ]);
  });

  it("constructs no provider until a key is stored, then one after", async () => {
    const store = new MemorySecretStore();
    const reg = authRegistry(store);
    const anthropic = entryOf(reg, "anthropic");
    expect(await providerEntries(store).get("anthropic")!.instance.buildProvider()).toBeNull();

    if (anthropic.method.kind !== "api-key") throw new Error("expected api-key method");
    await anthropic.method.submit("sk-ant-test");
    expect(
      (await providerEntries(store).get("anthropic")!.instance.buildProvider())?.provider,
    ).toBe("anthropic");
  });

  it("picks up a key from the environment variable", async () => {
    const entries = providerEntries(new MemorySecretStore());
    process.env.OPENAI_API_KEY = "sk-env";
    expect((await entries.get("openai")!.instance.buildProvider())?.provider).toBe("openai");
  });

  it("constructs an opencode-go provider from its key", async () => {
    const entries = providerEntries(new MemorySecretStore());
    process.env.OPENCODE_API_KEY = "oc-test";
    expect((await entries.get("opencode-go")!.instance.buildProvider())?.provider).toBe(
      "opencode-go",
    );
  });
});
