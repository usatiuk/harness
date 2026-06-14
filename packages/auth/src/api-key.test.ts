import { MemorySecretStore } from "@harness/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyAuth } from "./api-key.ts";

const ENV = "TEST_API_KEY";

const make = (): ApiKeyAuth =>
  new ApiKeyAuth({
    id: "test",
    label: "Test",
    store: new MemorySecretStore(),
    envVar: ENV,
    validate: (k) => (k.startsWith("sk-") ? null : "must start with sk-"),
  });

describe("ApiKeyAuth", () => {
  beforeEach(() => delete process.env[ENV]);
  afterEach(() => delete process.env[ENV]);

  it("stores and reads back a key", async () => {
    const auth = make();
    await auth.submit("sk-stored");
    expect(await auth.getKey()).toBe("sk-stored");
  });

  it("trims and validates on submit", async () => {
    const auth = make();
    await auth.submit("  sk-trim  ");
    expect(await auth.getKey()).toBe("sk-trim");
    await expect(auth.submit("bad")).rejects.toThrow("must start with sk-");
    await expect(auth.submit("   ")).rejects.toThrow("must not be empty");
  });

  it("prefers the environment variable over the stored key", async () => {
    const auth = make();
    await auth.submit("sk-stored");
    process.env[ENV] = "sk-env";
    expect(await auth.getKey()).toBe("sk-env");
  });

  it("reports the active source in status", async () => {
    const auth = make();
    expect(await auth.status()).toEqual({ authenticated: false });

    await auth.submit("sk-stored");
    expect(await auth.status()).toMatchObject({ authenticated: true, source: "stored" });

    process.env[ENV] = "sk-env";
    expect(await auth.status()).toMatchObject({ authenticated: true, source: "env" });
  });

  it("logout removes the stored key but not the env override", async () => {
    const auth = make();
    await auth.submit("sk-stored");
    expect(await auth.logout()).toBe(true);
    expect(await auth.getKey()).toBeNull();
    expect(await auth.logout()).toBe(false);
  });
});
