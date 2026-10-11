import { describe, expect, it } from "vitest";
import { appSettingsUpdateRequest } from "./client-protocol.ts";

describe("auto-approval timeout settings", () => {
  const settings = {
    model: null,
    approval: {
      inWorkspace: "ask",
      outOfWorkspace: "ask",
      humanApprovalTimeoutSeconds: 60,
    },
    autoApproval: { enabled: false, model: null },
    sandbox: "local",
  };

  it("defaults older client settings to thirty seconds", () => {
    expect(appSettingsUpdateRequest.params.parse(settings).autoApproval.timeoutSeconds).toBe(30);
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
