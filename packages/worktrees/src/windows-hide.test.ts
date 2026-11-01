import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git, listWorktrees } from "./git.ts";
import { readChangeDiff } from "./changes.ts";

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown> | undefined;
}

const calls = vi.hoisted(() => [] as RecordedCall[]);

// The server can run without a console (desktop launch), so every git child
// must request CREATE_NO_WINDOW or Windows flashes it a console window.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const util = await import("node:util");
  type Options = Record<string, unknown>;
  const record = (command: string, args: readonly string[], options: Options | undefined): void => {
    calls.push({ command, args, options });
  };
  const execFile = ((...args: unknown[]) => {
    const [command, commandArgs] = args as [string, readonly string[]];
    const options = args.find(
      (value): value is Options => typeof value === "object" && value !== null,
    );
    const callback = args.find(
      (value): value is (...callbackArgs: unknown[]) => void => typeof value === "function",
    );
    record(command, commandArgs, options);
    callback?.(null, "", "");
  }) as unknown as typeof actual.execFile;
  Object.defineProperty(execFile, util.promisify.custom, {
    value: (command: string, args: readonly string[], options?: Options) => {
      record(command, args, options);
      const cwdIndex = args.indexOf("-C");
      const stdout = args.includes("--show-toplevel") ? `${args[cwdIndex + 1] ?? ""}\n` : "";
      return Promise.resolve({ stdout, stderr: "" });
    },
  });
  return { ...actual, execFile };
});

const roots: string[] = [];
afterEach(async () => {
  calls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("requests windowsHide on every git subprocess", async () => {
  await git("/repo", ["rev-parse", "HEAD"]);
  await listWorktrees("/repo");
  // A checkout-shaped directory walks readChangeDiff down to its direct git diff call.
  const root = await mkdtemp(join(tmpdir(), "harness-windows-hide-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  await readChangeDiff(root, { mode: "unstaged", path: "file.txt" });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.command).toBe("git");
    expect(call.options).toMatchObject({ windowsHide: true });
  }
});
