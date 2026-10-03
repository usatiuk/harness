import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DpapiSecretStore, defaultDpapiCredentialsPath } from "./dpapi.ts";
import { secretStoreContract } from "./secret-store.contract.ts";

const roots: string[] = [];

function freshPath(): string {
  const root = mkdtempSync(join(tmpdir(), "dpapi-"));
  roots.push(root);
  return join(root, "credentials.dpapi");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

if (process.platform === "win32") {
  secretStoreContract("DpapiSecretStore", () => new DpapiSecretStore(freshPath()));
}

describe.runIf(process.platform === "win32")("DpapiSecretStore on Windows", () => {
  it("preserves concurrent updates and deletions across Windows case aliases of one file", async () => {
    const path = freshPath();
    const first = new DpapiSecretStore(path);
    const second = new DpapiSecretStore(path.toUpperCase());
    await Promise.all([first.set("openai", "first"), second.set("anthropic", "second")]);
    expect(await first.get("openai")).toBe("first");
    expect(await second.get("anthropic")).toBe("second");
    expect(await Promise.all([first.delete("openai"), second.delete("anthropic")])).toEqual([
      true,
      true,
    ]);
    expect(await first.get("openai")).toBeNull();
    expect(await second.get("anthropic")).toBeNull();
  });
  it("uses LOCALAPPDATA for the default credential path", () => {
    const localAppData = join(tmpdir(), "harness-local-app-data");
    vi.stubEnv("LOCALAPPDATA", localAppData);
    expect(defaultDpapiCredentialsPath()).toBe(join(localAppData, "Harness", "credentials.dpapi"));
  });

  it("fails clearly when LOCALAPPDATA is unavailable", () => {
    vi.stubEnv("LOCALAPPDATA", "");
    expect(() => defaultDpapiCredentialsPath()).toThrow(/LOCALAPPDATA is not set/);
  });

  it("distinguishes bytes that DPAPI cannot decrypt", async () => {
    const path = freshPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([1, 2, 3]));
    await expect(new DpapiSecretStore(path).get("token")).rejects.toThrow(
      /could not decrypt Windows credentials/,
    );
  });

  it("distinguishes decrypted but corrupt credential data", async () => {
    const path = freshPath();
    const { Dpapi } = await import("@primno/dpapi");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Dpapi.protectData(Buffer.from("not JSON", "utf8"), null, "CurrentUser"));
    await expect(new DpapiSecretStore(path).get("token")).rejects.toThrow(
      /Windows credential file .* is corrupt/,
    );
  });

  it("round-trips a secret larger than the Windows Credential Manager limit", async () => {
    const store = new DpapiSecretStore(freshPath());
    const value = `žluťoučký-${"x".repeat(10_000)}`;
    await store.set("large-token", value);
    expect(await store.get("large-token")).toBe(value);
  });

  it("passes the native availability probe", async () => {
    await expect(DpapiSecretStore.probe()).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("DpapiSecretStore outside Windows", () => {
  it("rejects construction and probing", async () => {
    expect(() => new DpapiSecretStore(freshPath())).toThrow(/only on Windows/);
    await expect(DpapiSecretStore.probe()).rejects.toThrow(/only on Windows/);
  });
});
