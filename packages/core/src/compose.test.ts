import { describe, expect, it, vi } from "vitest";
import type {
  InteractionRequest,
  RequestMiddleware,
  RequestMiddlewareContext,
} from "@harness/protocol";
import { runRequestChain } from "./compose.ts";

const ctx = {} as RequestMiddlewareContext;
const request: InteractionRequest = { kind: "test", value: 1 };

describe("runRequestChain", () => {
  it("composes outer-to-inner and lets middleware wrap the terminal response", async () => {
    const order: string[] = [];
    const middleware = (id: string): RequestMiddleware => ({
      id,
      async wrap(req, _ctx, next) {
        order.push(`${id}:in`);
        const response = await next(req);
        order.push(`${id}:out`);
        return `${id}(${String(response)})`;
      },
    });
    const terminal = vi.fn(async () => "ui");

    await expect(
      runRequestChain([middleware("a"), middleware("b")], request, ctx, terminal),
    ).resolves.toBe("a(b(ui))");
    expect(order).toEqual(["a:in", "b:in", "b:out", "a:out"]);
    expect(terminal).toHaveBeenCalledWith(request);
  });

  it("short-circuits without reaching the terminal", async () => {
    const terminal = vi.fn(async () => "ui");
    const middleware: RequestMiddleware = {
      id: "answer",
      wrap: async () => ({ answer: true }),
    };
    await expect(runRequestChain([middleware], request, ctx, terminal)).resolves.toEqual({
      answer: true,
    });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("rejects a second next call", async () => {
    const middleware: RequestMiddleware = {
      id: "broken",
      async wrap(req, _ctx, next) {
        await next(req);
        return next(req);
      },
    };
    await expect(runRequestChain([middleware], request, ctx, async () => "ui")).rejects.toThrow(
      /called next twice/,
    );
  });
});
