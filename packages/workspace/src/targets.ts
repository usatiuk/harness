import type { ToolCall } from "@harness/protocol";
import { splitCustomEscalation } from "@harness/execution";
import { parseEnvelope } from "./apply-patch-parse.ts";

const pathArg = (args: unknown): string[] => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const path: unknown = (args as Record<string, unknown>).path;
  return typeof path === "string" ? [path] : [];
};

/**
 * Target paths exposed by an available Harness-owned file call after its owning tool has validated
 * the arguments. Unknown calls and malformed custom patches return no targets.
 */
export function fileTargetsOfValidatedCall(call: ToolCall): string[] {
  switch (call.name) {
    case "read_file":
    case "write":
    case "edit":
      return pathArg(call.args);
    case "apply_patch": {
      const patch =
        typeof call.args === "string"
          ? call.args
          : call.args && typeof call.args === "object" && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>).patch
            : undefined;
      if (typeof patch !== "string") return [];
      try {
        const changes = parseEnvelope(splitCustomEscalation(patch).input);
        return changes.flatMap((change) =>
          change.type === "update_file" && change.newPath
            ? [change.path, change.newPath]
            : [change.path],
        );
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}
