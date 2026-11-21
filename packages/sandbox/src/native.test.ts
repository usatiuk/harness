import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { NativeExecutionContext } from "./native.ts";

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-native-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NativeExecutionContext", () => {
  it("classifies only registered execution calls and recognizes both escalation encodings", async () => {
    const root = await makeRoot();
    const ctx = new NativeExecutionContext(root, { workspaceWrite: true, network: true });
    ctx.registerManagedTool("bash");
    ctx.registerManagedTool("apply_patch");
    expect(ctx.classify({ callId: "1", name: "bash", args: { command: "ls" } })).toBe(
      "in-workspace",
    );
    expect(
      ctx.classify({
        callId: "2",
        name: "bash",
        args: {
          command: "ls",
          sandbox_permissions: "require_escalated",
          justification: "host",
        },
      }),
    ).toBe("out-of-workspace");
    expect(
      ctx.classify({
        callId: "3",
        name: "apply_patch",
        args: "sandbox_permissions=require_escalated\njustification=host\n---\n*** Begin Patch\n*** End Patch",
      }),
    ).toBe("out-of-workspace");
    expect(ctx.classify({ callId: "4", name: "web_search", args: {} })).toBe("unknown");
  });
});
