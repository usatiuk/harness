import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAuthStore, setAuthStore, updateGlobalModel } from "./write.ts";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "cfg-"));

describe("auth store persistence", () => {
  it("returns undefined before any backend is chosen", async () => {
    expect(await getAuthStore(freshHome())).toBeUndefined();
  });

  it("round-trips the chosen backend", async () => {
    const home = freshHome();
    await setAuthStore(home, "file");
    expect(await getAuthStore(home)).toBe("file");
    await setAuthStore(home, "keyring");
    expect(await getAuthStore(home)).toBe("keyring");
  });

  it("treats a malformed persisted value as no backend", async () => {
    const home = freshHome();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ auth: { store: "bogus" } }));
    expect(await getAuthStore(home)).toBeUndefined();
  });

  it("merges with the model so neither write clobbers the other", async () => {
    const home = freshHome();
    await updateGlobalModel(home, { provider: "openai", model: "gpt-5.1" });
    await setAuthStore(home, "file");
    await updateGlobalModel(home, { provider: "anthropic", model: "claude-opus-4-8" });
    expect(await getAuthStore(home)).toBe("file");
  });
});
