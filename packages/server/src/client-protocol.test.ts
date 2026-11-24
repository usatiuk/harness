import { describe, expect, it } from "vitest";
import { appSettingsUpdateRequest } from "./client-protocol.ts";

describe("auto-approval timeout settings", () => {
  it.each([0, -1, 1.5, Infinity, NaN])(
    "rejects invalid compaction threshold %s",
    (compactionThresholdTokens) => {
      expect(appSettingsUpdateRequest.params.safeParse({ compactionThresholdTokens }).success).toBe(
        false,
      );
    },
  );
  const settings = {
    model: null,
    conversationTitleModel: null,
    approval: {
      inWorkspace: "ask",
      outOfWorkspace: "ask",
      humanApprovalTimeoutSeconds: 60,
    },
    autoApproval: { enabled: false, model: null },
    sandbox: "none",
  };

  it("accepts older review settings without overwriting host timeouts", () => {
    const patch = appSettingsUpdateRequest.params.parse(settings);
    expect(patch.autoApproval!.timeoutSeconds).toBeGreaterThan(0);
    expect(patch).not.toHaveProperty("timeouts");
  });

  it.each([0, -1, 2147484, Infinity, NaN])("rejects invalid timeout %s", (timeoutSeconds) => {
    expect(
      appSettingsUpdateRequest.params.safeParse({
        ...settings,
        autoApproval: { ...settings.autoApproval, timeoutSeconds },
      }).success,
    ).toBe(false);
  });
});

it("uses canonical sandbox backend names at the API boundary", () => {
  for (const sandbox of ["none", "native", "docker"]) {
    expect(appSettingsUpdateRequest.params.parse({ sandbox }).sandbox).toBe(sandbox);
  }
  expect(appSettingsUpdateRequest.params.safeParse({ sandbox: "local" }).success).toBe(false);
});
