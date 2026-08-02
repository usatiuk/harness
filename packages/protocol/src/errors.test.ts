import { describe, expect, it } from "vitest";
import { formatError } from "./errors.ts";

describe("formatError", () => {
  it("renders nested transport causes and safe SDK metadata", () => {
    const socket = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    const fetch = new TypeError("fetch failed", { cause: socket });
    const api = Object.assign(new Error("Connection error.", { cause: fetch }), {
      name: "APIConnectionError",
    });

    expect(formatError(api)).toBe(
      [
        "APIConnectionError: Connection error.",
        "Caused by: TypeError: fetch failed",
        "Caused by: SocketError: other side closed [UND_ERR_SOCKET]",
      ].join("\n"),
    );
  });

  it("bounds circular causes", () => {
    const error = new Error("loop");
    error.cause = error;
    expect(formatError(error)).toBe("Error: loop");
  });

  it("preserves non-error failures", () => {
    expect(formatError("offline")).toBe("offline");
  });
});
