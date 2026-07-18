import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { killWindowsProcessTree } from "./windows-process.ts";

describe("killWindowsProcessTree", () => {
  it("falls back when taskkill errors or exits nonzero", () => {
    for (const outcome of ["error", "nonzero"] as const) {
      const helper = new EventEmitter();
      const child = { pid: 42, kill: vi.fn(() => true) };
      const spawnKiller = vi.fn(() => helper);
      killWindowsProcessTree(child, spawnKiller);
      if (outcome === "error") helper.emit("error", new Error("blocked"));
      else helper.emit("exit", 1);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/PID", "42", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  });

  it("does not use the fallback after successful tree termination", () => {
    const helper = new EventEmitter();
    const child = { pid: 42, kill: vi.fn(() => true) };
    killWindowsProcessTree(child, () => helper);
    helper.emit("exit", 0);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
