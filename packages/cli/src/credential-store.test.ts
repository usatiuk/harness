import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuthStore } from "@harness/config";
import { DpapiSecretStore } from "@harness/secrets";
import { describe, expect, it, vi } from "vitest";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "cred-"));
const fileProbe = (): Promise<"file"> => Promise.resolve("file");
const keyringProbe = (): Promise<"keyring"> => Promise.resolve("keyring");
const dpapiProbe = (): Promise<"dpapi"> => Promise.resolve("dpapi");

describe("credentialStoreForRead", () => {
  it("reports no backend (env-only) before any login", async () => {
    expect((await credentialStoreForRead(freshHome())).kind).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "uses the persisted keyring backend on Unix",
    async () => {
      const home = freshHome();
      await setAuthStore(home, "keyring");
      expect((await credentialStoreForRead(home)).kind).toBe("keyring");
    },
  );

  it.runIf(process.platform === "win32")(
    "uses the persisted DPAPI backend on Windows",
    async () => {
      const home = freshHome();
      await setAuthStore(home, "dpapi");
      expect((await credentialStoreForRead(home)).kind).toBe("dpapi");
    },
  );

  describe.runIf(process.platform === "win32")("unsupported persisted Windows backends", () => {
    it.each(["file", "keyring"] as const)("rejects %s", async (kind) => {
      const home = freshHome();
      await setAuthStore(home, kind);
      await expect(credentialStoreForRead(home)).rejects.toThrow(/use DPAPI/);
    });
  });

  it.skipIf(process.platform === "win32")("rejects a persisted DPAPI backend on Unix", async () => {
    const home = freshHome();
    await setAuthStore(home, "dpapi");
    await expect(credentialStoreForRead(home)).rejects.toThrow(/only on Windows/);
  });
});

describe("credentialStoreForLogin", () => {
  it.skipIf(process.platform === "win32")("probes only when nothing is chosen yet", async () => {
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(freshHome(), undefined, probe)).kind).toBe("file");
    expect(probe).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")("uses DPAPI when probing succeeds", async () => {
    expect((await credentialStoreForLogin(freshHome(), undefined, dpapiProbe)).kind).toBe("dpapi");
  });

  it.runIf(process.platform === "win32")("preserves the DPAPI probe failure", async () => {
    const failure = new Error("backend unavailable");
    vi.spyOn(DpapiSecretStore, "probe").mockRejectedValueOnce(failure);
    await expect(credentialStoreForLogin(freshHome())).rejects.toMatchObject({
      message: "Windows DPAPI is unavailable",
      cause: failure,
    });
  });

  describe.runIf(process.platform === "win32")("unsupported Windows overrides", () => {
    it.each(["file", "keyring"] as const)("rejects explicit %s", async (kind) => {
      await expect(credentialStoreForLogin(freshHome(), kind, dpapiProbe)).rejects.toThrow(
        /use DPAPI/,
      );
    });
  });

  it("honors an explicit override without probing", async () => {
    const probe = vi.fn(fileProbe);
    const nativeKind = process.platform === "win32" ? "dpapi" : "keyring";
    expect((await credentialStoreForLogin(freshHome(), nativeKind, probe)).kind).toBe(nativeKind);
    expect(probe).not.toHaveBeenCalled();
  });

  it("prefers the persisted choice over a probe", async () => {
    const home = freshHome();
    const nativeKind = process.platform === "win32" ? "dpapi" : "keyring";
    await setAuthStore(home, nativeKind);
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(home, undefined, probe)).kind).toBe(nativeKind);
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects an explicit DPAPI override on Unix",
    async () => {
      await expect(credentialStoreForLogin(freshHome(), "dpapi", keyringProbe)).rejects.toThrow(
        /only on Windows/,
      );
    },
  );
});
