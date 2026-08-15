import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HARNESS_PROTOCOL_VERSION,
  defineRequest,
  initializeParamsSchema,
  jsonValueSchema,
} from "./rpc.ts";

describe("RPC contracts", () => {
  it("accepts only JSON values", () => {
    expect(jsonValueSchema.parse({ nested: [null, true, 3, "x"] })).toEqual({
      nested: [null, true, 3, "x"],
    });
    expect(() => jsonValueSchema.parse({ missing: undefined })).toThrow();
    expect(() => jsonValueSchema.parse(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("keeps initialization exact and rejects unknown fields", () => {
    const params = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      client: { name: "test", version: "1.0.0" },
      plugins: [{ id: "approval", version: 1 }],
    };

    expect(initializeParamsSchema.parse(params)).toEqual(params);
    expect(() => initializeParamsSchema.parse({ ...params, extra: true })).toThrow();
  });

  it("declares direction and schemas once", () => {
    const echo = defineRequest({
      direction: "server-to-client",
      method: "test.echo",
      params: z.strictObject({ value: z.string() }),
      result: z.strictObject({ value: z.string() }),
    });

    expect(echo.kind).toBe("request");
    expect(echo.direction).toBe("server-to-client");
    expect(echo.params.parse({ value: "hello" })).toEqual({ value: "hello" });
  });
});
