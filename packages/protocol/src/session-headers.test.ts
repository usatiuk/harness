import { describe, expect, it } from "vitest";
import { sessionIdHeaderSchema } from "./session-headers.ts";

describe("session header configuration", () => {
  it.each(["x-session-id", "x-opencode-session", "x-affinity", "X-LiteLLM-Session-Id"])(
    "accepts provider routing header %s",
    (name) => {
      expect(sessionIdHeaderSchema.parse(name)).toBe(name.toLowerCase());
    },
  );
  it.each([
    "",
    "bad header",
    "x-session-id\r\nAuthorization",
    "Authorization",
    "Cookie",
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "X-API-Key",
  ])("rejects invalid or reserved header %s", (name) => {
    expect(sessionIdHeaderSchema.safeParse(name).success).toBe(false);
  });
});
