import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it("reports a command-interpreter spawn failure as an error", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const activity = createProcessActivity({
      id: "act_spawn_error",
      title: "missing shell",
      proc: {
        pid: undefined,
        exit: Promise.resolve({
          code: null,
          signal: null,
          error: new Error("spawn powershell.exe ENOENT"),
        }),
        onData: () => {},
        kill: () => {},
      },
      store: exec.outputStore("conv"),
    });
    const result = await activity.done;
    expect(result.status).toBe("error");
    expect(result.summary).toContain("failed to start");
    expect(result.summary).toContain("ENOENT");
  });

  it("kill terminates a long-running process", async () => {
    const root = await tmpRoot();
    const exec = new LocalExecutionContext(root);
    const pidFile = join(root, "child.pid");
    const fixture = fileURLToPath(new URL("./fixtures/long-running-child.js", import.meta.url));
    const invoke =
      exec.shellKind === "powershell" ? `& "${process.execPath}"` : `"${process.execPath}"`;
    const activity = createProcessActivity({
      id: "act_kill",
      title: "long-running child",
      proc: exec.spawn(`${invoke} "${fixture}" "${pidFile}"`),
      store: exec.outputStore("conv"),
    });
    const descendantPid = await waitForPid(pidFile);
    expect(processExists(descendantPid)).toBe(true);
    activity.kill();
    activity.kill();
    const result = await activity.done;
    expect(result.status).toBe("error"); // killed ⇒ nonzero/terminated
    await vi.waitFor(() => expect(processExists(descendantPid)).toBe(false), { timeout: 5_000 });
  }, 10_000);
});
