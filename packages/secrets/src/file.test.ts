import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSecretStore } from "./file.ts";
import { secretStoreContract } from "./secret-store.contract.ts";

const freshPath = (): string => join(mkdtempSync(join(tmpdir(), "secrets-")), "credentials.json");

if (process.platform !== "win32") {
  secretStoreContract("FileSecretStore", () => new FileSecretStore(freshPath()));
}

describe.skipIf(process.platform === "win32")("FileSecretStore permissions", () => {
  it("preserves parallel mutations across independent store instances", async () => {
    const path = freshPath();
    try {
      const first = new FileSecretStore(path),
        second = new FileSecretStore(path);
      await Promise.all([first.set("openai", "first"), second.set("anthropic", "second")]);
      expect(await first.get("openai")).toBe("first");
      expect(await second.get("anthropic")).toBe("second");
      await Promise.all([first.delete("openai"), second.delete("anthropic")]);
      expect(await first.get("openai")).toBeNull();
      expect(await second.get("anthropic")).toBeNull();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
  it("writes the credentials file with mode 0600", async () => {
    const path = freshPath();
    const store = new FileSecretStore(path);
    await store.set("k", "v");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe.runIf(process.platform === "win32")("FileSecretStore on Windows", () => {
  it("rejects storage that cannot provide the promised owner-only permissions", () => {
    expect(() => new FileSecretStore(freshPath())).toThrow(/DPAPI/);
  });
});
