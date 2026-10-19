import { describe, expect, it } from "vitest";
import { networkFailureReason, retryAfterMsFromHeaders } from "./failure-classification.ts";

function coded(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, { cause }), { code });
}

describe("networkFailureReason", () => {
  it.each(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "recognizes the transport code %s",
    (code) => expect(networkFailureReason(coded(code))).toBe("connection"),
  );

  it.each(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"])(
    "recognizes the timeout code %s through wrappers",
    (code) => {
      const error = new Error("SDK wrapper", {
        cause: new TypeError("fetch failed", { cause: coded(code) }),
      });
      expect(networkFailureReason(error)).toBe("timeout");
    },
  );

  it("does not mask a timeout behind a generic connection code", () => {
    expect(networkFailureReason(coded("ECONNRESET", coded("ETIMEDOUT")))).toBe("timeout");
  });

  it("bounds cause traversal", () => {
    let error: unknown = coded("ECONNRESET");
    for (let depth = 0; depth < 4; depth++) error = new Error("wrapper", { cause: error });
    expect(networkFailureReason(error)).toBeUndefined();
  });

  it("terminates cyclic causes", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(networkFailureReason(error)).toBeUndefined();
  });

  it.each([
    new TypeError("fetch failed", { cause: new Error("unknown scheme") }),
    new TypeError("network socket failure"),
    Object.assign(new Error("SDK-like"), { name: "APIConnectionError" }),
    Object.assign(new Error("invalid configuration"), { code: "UND_ERR_INVALID_ARG" }),
    null,
    "ECONNRESET",
  ])("does not infer transport failures from identity or prose: %s", (error) => {
    expect(networkFailureReason(error)).toBeUndefined();
  });
});

describe("retryAfterMsFromHeaders", () => {
  it("prefers the millisecond header", () => {
    expect(
      retryAfterMsFromHeaders({
        headers: new Headers({ "retry-after-ms": "1250", "retry-after": "5" }),
      }),
    ).toBe(1250);
  });

  it("falls back from invalid milliseconds to delta-seconds", () => {
    expect(
      retryAfterMsFromHeaders({
        headers: new Headers({ "retry-after-ms": "later", "retry-after": "0.5" }),
      }),
    ).toBe(500);
  });

  it("leaves unavailable or invalid waits unspecified", () => {
    expect(retryAfterMsFromHeaders({})).toBeUndefined();
    expect(
      retryAfterMsFromHeaders({ headers: new Headers({ "retry-after": "later" }) }),
    ).toBeUndefined();
  });
});
