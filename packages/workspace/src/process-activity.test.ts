import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@harness/protocol";
import { LocalExecutionContext, type ProcessExit, type SpawnedProcess } from "@harness/execution";
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

/** A deterministic stand-in for a spawned process: the test emits chunks, then finishes it. */
function scriptedProc(): {
  proc: SpawnedProcess;
  emit(chunk: string): void;
  finish(code?: number): void;
} {
  let listener!: (chunk: string) => void;
  let resolveExit!: (exit: ProcessExit) => void;
  const exit = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  return {
    proc: {
      pid: undefined,
      exit,
      onData: (l) => {
        listener = l;
      },
      kill: () => {},
    },
    emit: (chunk) => listener(chunk),
    finish: (code = 0) => resolveExit({ code, signal: null }),
  };
}

/** Numbered lines 1..n with no trailing newline, so the view math is exact. */
const numbered = (n: number): string =>
  Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");

describe("createProcessActivity", () => {
  it("keeps the default 40-line tail", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const scripted = scriptedProc();
    const activity = createProcessActivity({
      id: "act_tail40",
      title: "numbered",
      proc: scripted.proc,
      store: exec.outputStore("conv"),
    });
    scripted.emit(numbered(100));
    scripted.finish();
    const result = await activity.done;
    expect(result.status).toBe("ok");
    const body = text(result.view);
    expect(body).toContain("…[60 more lines]");
    expect(body).toMatch(/^61$/m); // tail keeps lines 61..100
    expect(body).toMatch(/\n100$/);
    expect(body).not.toMatch(/^60$/m);
  });

  it("renders a widened tail when the activity carries max_lines", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const scripted = scriptedProc();
    const activity = createProcessActivity({
      id: "act_tail200",
      title: "numbered",
      proc: scripted.proc,
      store: exec.outputStore("conv"),
      view: { maxLines: 200 },
    });
    // Emit in two chunks to exercise accumulation; the widened view still covers everything.
    const all = numbered(200);
    const splitAt = all.indexOf("\n101\n");
    scripted.emit(all.slice(0, splitAt));
    scripted.emit(all.slice(splitAt));
    scripted.finish();
    const result = await activity.done;
    expect(result.status).toBe("ok");
    const body = text(result.view);
    expect(body).not.toContain("more lines");
    expect(body).toMatch(/^1$/m);
    expect(body).toMatch(/^200$/m);
    // Live progress renders through the same widened view.
    expect(text(activity.peek())).toMatch(/^1$/m);
  });

  it("clamps an over-cap view to the 500-line hard cap", async () => {
    const exec = new LocalExecutionContext(await tmpRoot());
    const scripted = scriptedProc();
    const activity = createProcessActivity({
      id: "act_tailclamp",
      title: "numbered",
      proc: scripted.proc,
      store: exec.outputStore("conv"),
      view: { maxLines: 5_000 },
    });
    scripted.emit(numbered(600));
    scripted.finish();
    const result = await activity.done;
    expect(result.status).toBe("ok");
    const body = text(result.view);
    expect(body).toContain("…[100 more lines]");
    expect(body).not.toMatch(/^100$/m);
    expect(body).toMatch(/^101$/m);
  });

  it.each([0, -5, 2.5])("throws on a non-positive-integer view maxLines=%s", async (maxLines) => {
    const fake = {
      pid: undefined,
      exit: Promise.resolve({ code: 0, signal: null }),
      onData: () => {},
      kill: () => {},
    };
    const exec = new LocalExecutionContext(await tmpRoot());
    expect(() =>
      createProcessActivity({
        id: "act_badview",
        title: "bad view",
        proc: fake,
        store: exec.outputStore("conv"),
        view: { maxLines },
      }),
    ).toThrow(/positive integer/);
  });

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
