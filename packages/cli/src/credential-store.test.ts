import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuthStore } from "@harness/config";
import { KeyringSecretStore } from "@harness/secrets";
import { describe, expect, it, vi } from "vitest";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "cred-"));
const fileProbe = (): Promise<"file"> => Promise.resolve("file");
const keyringProbe = (): Promise<"keyring"> => Promise.resolve("keyring");

describe("credentialStoreForRead", () => {
  it("reports no backend (env-only) before any login", async () => {
    expect((await credentialStoreForRead(freshHome())).kind).toBeNull();
  });

  it("uses the persisted keyring backend", async () => {
    const home = freshHome();
    await setAuthStore(home, "keyring");
    expect((await credentialStoreForRead(home)).kind).toBe("keyring");
  });

  it.runIf(process.platform === "win32")(
    "rejects a persisted file backend on Windows",
    async () => {
      const home = freshHome();
      await setAuthStore(home, "file");
      await expect(credentialStoreForRead(home)).rejects.toThrow(/Credential Manager/);
    },
  );
});

describe("credentialStoreForLogin", () => {
  it.skipIf(process.platform === "win32")("probes only when nothing is chosen yet", async () => {
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(freshHome(), undefined, probe)).kind).toBe("file");
    expect(probe).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")(
    "uses Credential Manager when probing succeeds",
    async () => {
      expect((await credentialStoreForLogin(freshHome(), undefined, keyringProbe)).kind).toBe(
        "keyring",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves the Credential Manager probe failure",
    async () => {
      const failure = new Error("backend unavailable");
      vi.spyOn(KeyringSecretStore.prototype, "get").mockRejectedValueOnce(failure);
      await expect(credentialStoreForLogin(freshHome())).rejects.toMatchObject({
        message: "Windows Credential Manager is unavailable",
        cause: failure,
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "round-trips through the real Windows Credential Manager backend",
    async () => {
      const { store } = await credentialStoreForLogin(freshHome(), "keyring");
      const key = `__harness_windows_ci_${randomUUID()}`;
      const value = `secret-${randomUUID()}`;
      try {
        await store.set(key, value);
        expect(await store.get(key)).toBe(value);
        expect(await store.delete(key)).toBe(true);
        expect(await store.get(key)).toBeNull();
      } finally {
        await store.delete(key).catch(() => {});
      }
    },
  );

  it.runIf(process.platform === "win32")("fails instead of falling back to a file", async () => {
    await expect(credentialStoreForLogin(freshHome(), undefined, fileProbe)).rejects.toThrow(
      /Credential Manager/,
    );
  });

  it.runIf(process.platform === "win32")("rejects an explicit file override", async () => {
    await expect(credentialStoreForLogin(freshHome(), "file", keyringProbe)).rejects.toThrow(
      /Credential Manager/,
    );
  });

  it("honors an explicit override without probing", async () => {
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(freshHome(), "keyring", probe)).kind).toBe("keyring");
    expect(probe).not.toHaveBeenCalled();
  });

  it("prefers the persisted choice over a probe", async () => {
    const home = freshHome();
    await setAuthStore(home, "keyring");
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(home, undefined, probe)).kind).toBe("keyring");
    expect(probe).not.toHaveBeenCalled();
  });
});
