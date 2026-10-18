import { describe, expect, it } from "vitest";
import { classifyTransientFailure } from "./failure-classification.ts";
import { TransientModelFailure } from "./model.ts";

/**
 * Stand-ins for SDK transport errors: the installed OpenAI and Anthropic SDKs
 * keep `name` as `"Error"` and carry their identity on the constructor, so
 * classification must read both spellings.
 */
class APIConnectionError extends Error {}
class APIConnectionTimeoutError extends APIConnectionError {}
class APIUserAbortError extends Error {}

describe("classifyTransientFailure error identity", () => {
  it("classifies SDK connection errors by constructor when name stays Error", () => {
    const error = new APIConnectionError("Connection error.");
    expect(error.name).toBe("Error");
    const failure = classifyTransientFailure(error);
    expect(failure).toBeInstanceOf(TransientModelFailure);
    expect(failure?.reason).toBe("connection");
    expect(failure?.cause).toBe(error);
  });

  it("classifies SDK connection timeouts as timeout", () => {
    const error = new APIConnectionTimeoutError("Request timed out.");
    expect(error.name).toBe("Error");
    expect(classifyTransientFailure(error)?.reason).toBe("timeout");
  });

  it("walks the cause chain when the SDK error carries a coded cause", () => {
    const cause = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const error = Object.assign(new APIConnectionError("Connection error."), { cause });
    expect(classifyTransientFailure(error)?.reason).toBe("connection");
  });

  it("never classifies an SDK user abort", () => {
    const error = new APIUserAbortError("Request was aborted.");
    expect(error.name).toBe("Error");
    expect(classifyTransientFailure(error)).toBeUndefined();
  });

  it("never classifies an abort even when it carries transient signals", () => {
    const network = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const byKind = Object.assign(new APIUserAbortError("Request was aborted."), {
      cause: network,
      status: 503,
    });
    expect(classifyTransientFailure(byKind)).toBeUndefined();
    const byName = Object.assign(new Error("aborted"), {
      name: "APIUserAbortError",
      cause: network,
      status: 503,
    });
    expect(classifyTransientFailure(byName)).toBeUndefined();
  });

  it("prefers a coded cause over the bare fetch-failed message", () => {
    const cause = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(classifyTransientFailure(new TypeError("fetch failed", { cause }))?.reason).toBe(
      "timeout",
    );
  });

  it("never classifies a DOMException abort", () => {
    expect(classifyTransientFailure(new DOMException("aborted", "AbortError"))).toBeUndefined();
  });

  it("leaves unrecognized errors for the caller to rethrow", () => {
    expect(classifyTransientFailure(new Error("boom"))).toBeUndefined();
  });
});
