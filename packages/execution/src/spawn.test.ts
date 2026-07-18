import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { streamProcess } from "./spawn.ts";

describe("streamProcess", () => {
  it("preserves a child spawn error as the terminal outcome", async () => {
    const child = new EventEmitter() as ChildProcess;
    const proc = streamProcess(child, vi.fn());
    const error = new Error("spawn powershell.exe ENOENT");
    child.emit("error", error);
    await expect(proc.exit).resolves.toEqual({ code: null, signal: null, error });
  });
});
