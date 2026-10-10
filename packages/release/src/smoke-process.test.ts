import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  smokeProcessDeadline,
  terminateSmokeProcess,
  awaitSmokeExit,
} from "../../../release/tools/smoke-process.ts";

describe("headless smoke subprocess retirement", () => {
  it("retires a real descendant that holds its parent's output pipes", async () => {
    const script = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2],windowsHide:true});
      child.once('spawn',()=>console.log(child.pid));
      setInterval(()=>{},1000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    let retired = false;
    try {
      const pid = await new Promise<number>((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error("Fixture exited before creating its descendant")),
        );
        child.stdout.on("data", (bytes: Buffer) => {
          text += bytes.toString();
          if (text.includes("\n")) resolve(Number(text.trim()));
        });
      });
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      process.kill(pid, 0);
      const deadline = smokeProcessDeadline(child, exited, 1);
      await expect(deadline.expired).rejects.toThrow("deadline");
      await deadline.finish();
      retired = true;
      // The inherited output pipe closing proves the descendant retired. Unix
      // may retain its exited PID as a zombie until the system reaps it.
      if (process.platform === "win32") expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (!retired && child.exitCode === null && child.signalCode === null) {
        await terminateSmokeProcess(child);
        await awaitSmokeExit(exited);
      }
    }
  });
});
