import { describe, expect, it } from "vitest";
import { apiKeyCredentials } from "./index.ts";

describe("apiKeyCredentials", () => {
  it("disables SDK-internal retries; the model-retry middleware owns re-issue", async () => {
    const credentials = apiKeyCredentials({ apiKey: "test-key" });
    expect((await credentials.client(new AbortController().signal)).maxRetries).toBe(0);
  });
});
