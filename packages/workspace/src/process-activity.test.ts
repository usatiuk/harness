import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { createProcessActivity } from "./process-activity.ts";

const created: string[] = [];
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hproc-"));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const text = (blocks: ContentBlock[]): string =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");

describe("createProcessActivity", () => {
  it("captures output and a zero exit as ok", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const activity = createProcessActivity({
      id: "act_ok",
      title: "echo hi",
      proc: exec.spawn("echo hi"),
      store: exec.outputStore("conv"),
    });
    const result = await activity.done;
    expect(result.status).toBe("ok");
    expect(text(result.view)).toContain("hi");
  });

  it("reports a nonzero exit as an error", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const activity = createProcessActivity({
      id: "act_err",
      title: "exit 3",
      proc: exec.spawn("exit 3"),
      store: exec.outputStore("conv"),
    });
    const result = await activity.done;
    expect(result.status).toBe("error");
    expect(result.summary).toContain("exited 3");
  });

  it("kill terminates a long-running process", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const activity = createProcessActivity({
      id: "act_kill",
      title: "sleep 30",
      proc: exec.spawn("sleep 30"),
      store: exec.outputStore("conv"),
    });
    activity.kill();
    const result = await activity.done;
    expect(result.status).toBe("error"); // killed ⇒ nonzero/terminated
  });
});
