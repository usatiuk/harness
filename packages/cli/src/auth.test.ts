import { MemorySecretStore } from "@harness/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authRegistry, type AuthEntry } from "./auth.ts";

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
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("exposes the known providers", () => {
    expect([...authRegistry(new MemorySecretStore()).keys()]).toEqual([
      "openai",
      "anthropic",
      "openai-codex",
    ]);
  });

  it("builds no plugin until a key is stored, then one after", async () => {
    const reg = authRegistry(new MemorySecretStore());
    const anthropic = entryOf(reg, "anthropic");
    expect(await anthropic.buildPlugin()).toBeNull();

    if (anthropic.method.kind !== "api-key") throw new Error("expected api-key method");
    await anthropic.method.submit("sk-ant-test");
    expect((await anthropic.buildPlugin())?.id).toBe("anthropic-api");
  });

  it("picks up a key from the environment variable", async () => {
    const reg = authRegistry(new MemorySecretStore());
    process.env.OPENAI_API_KEY = "sk-env";
    expect((await entryOf(reg, "openai").buildPlugin())?.id).toBe("openai-api");
  });
});
