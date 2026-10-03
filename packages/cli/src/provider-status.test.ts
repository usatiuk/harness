import { expect, it } from "vitest";
import type { ProviderStatus } from "@harness/server/client-protocol";
import { modelAvailabilityMessage } from "./provider-status.ts";

it("distinguishes an empty discovered catalog from missing credentials and preserves the selection", () => {
  const status: ProviderStatus = {
    id: "work",
    label: "Company gateway",
    type: "litellm",
    kind: "api-key",
    canStore: true,
    authenticated: true,
    detail: null,
    credentialSource: "stored",
    registered: true,
    catalog: "failed",
    modelCount: 0,
    diagnostics: ["Catalog request returned HTTP 503"],
  };
  const model = { provider: "work", model: "coding" };
  expect(modelAvailabilityMessage([], [status], model)).toContain(
    "Company gateway (work/coding) is unavailable: failed",
  );
  expect(modelAvailabilityMessage([], [status], model)).toContain("selection is preserved");
  expect(
    modelAvailabilityMessage([], [{ ...status, catalog: "missing-credentials" }], model),
  ).toContain("auth login --provider work");
  expect(
    modelAvailabilityMessage([{ provider: "work", model: "coding" }], [status], model),
  ).toBeUndefined();
  expect(model).toEqual({ provider: "work", model: "coding" });
});
