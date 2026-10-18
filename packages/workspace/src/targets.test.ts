import { describe, expect, it } from "vitest";
import type { ToolCall } from "@harness/protocol";
import { fileTargetsOfValidatedCall } from "./targets.ts";

const call = (name: string, args: unknown): ToolCall => ({ callId: "call", name, args });

describe("fileTargetsOfValidatedCall", () => {
  it.each(["read_file", "write", "edit"])("extracts the path from %s", (name) =>
    expect(fileTargetsOfValidatedCall(call(name, { path: "src/a.ts" }))).toEqual(["src/a.ts"]),
  );

  it("extracts every apply_patch source and move destination", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+new",
      "*** Update File: src/old.ts",
      "*** Move to: lib/moved.ts",
      "@@",
      "-old",
      "+moved",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");

    expect(fileTargetsOfValidatedCall(call("apply_patch", patch))).toEqual([
      "src/new.ts",
      "src/old.ts",
      "lib/moved.ts",
      "gone.ts",
    ]);
  });

  it("accepts an escalated patch envelope", () => {
    const patch = [
      "sandbox_permissions=require_escalated",
      "justification=outside write",
      "---",
      "*** Begin Patch",
      "*** Delete File: ../gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(fileTargetsOfValidatedCall(call("apply_patch", patch))).toEqual(["../gone.ts"]);
  });

  it("leaves unknown and malformed calls to their owning tools", () => {
    expect(fileTargetsOfValidatedCall(call("bash", { command: "cat src/a.ts" }))).toEqual([]);
    expect(fileTargetsOfValidatedCall(call("glob", { path: "src", pattern: "**/*" }))).toEqual([]);
    expect(fileTargetsOfValidatedCall(call("apply_patch", "broken"))).toEqual([]);
  });
});
