import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSecretStore } from "./file.ts";
import { secretStoreContract } from "./secret-store.contract.ts";

const freshPath = (): string => join(mkdtempSync(join(tmpdir(), "secrets-")), "credentials.json");

secretStoreContract("FileSecretStore", () => new FileSecretStore(freshPath()));

describe("FileSecretStore permissions", () => {
  it("writes the credentials file with mode 0600", async () => {
    const path = freshPath();
    const store = new FileSecretStore(path);
    await store.set("k", "v");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
