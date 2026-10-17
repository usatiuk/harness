import type { CodeEvaluator } from "@harness/protocol";

/** For fixtures exercising direct essential tools; guest execution requires a real evaluator. */
export const unusedCodeEvaluator: CodeEvaluator = {
  evaluate() {
    throw new Error("unexpected guest execution in a direct-tool fixture");
  },
};
