import { okResult, type Tool } from "@harness/protocol";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";

const schema = z.strictObject({ timeout_seconds: z.number().positive().max(300).optional() });

export function waitTool(runtime: Runtime): Tool<z.infer<typeof schema>> {
  return {
    name: "wait",
    description:
      "Pause after all calls in this batch finish until steering, background completion, a subagent message, or timeout. Steering already pending for this turn skips the pause. Multiple waits use the shortest timeout. Defaults to 30 seconds, maximum 300.",
    exposure: { direct: true, code: false },
    input: { kind: "function", schema },
    execute: async ({ timeout_seconds = 30 }) => {
      const duration = timeout_seconds * 1000;
      runtime.pendingWaitMs = Math.min(runtime.pendingWaitMs ?? duration, duration);
      return okResult("Wait scheduled after this batch.");
    },
  };
}
