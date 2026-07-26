import { describe, expect, it } from "vitest";
import { KeyringSecretStore } from "./keyring.ts";

describe.runIf(process.platform === "win32")("KeyringSecretStore on Windows", () => {
  it("rejects before loading the native keyring backend", () => {
    expect(() => new KeyringSecretStore()).toThrow(/use DPAPI/);
  });
});
