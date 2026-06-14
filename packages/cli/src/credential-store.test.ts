import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuthStore } from "@harness/config";
import { describe, expect, it, vi } from "vitest";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "cred-"));
const fileProbe = (): Promise<"file"> => Promise.resolve("file");

describe("credentialStoreForRead", () => {
  it("reports no backend (env-only) before any login", async () => {
    expect((await credentialStoreForRead(freshHome())).kind).toBeNull();
  });

  it("uses the persisted backend", async () => {
    const home = freshHome();
    await setAuthStore(home, "file");
    expect((await credentialStoreForRead(home)).kind).toBe("file");
  });
});

describe("credentialStoreForLogin", () => {
  it("probes only when nothing is chosen yet", async () => {
    const probe = vi.fn(fileProbe);
    expect((await credentialStoreForLogin(freshHome(), undefined, probe)).kind).toBe("file");
    expect(probe).toHaveBeenCalledOnce();
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
