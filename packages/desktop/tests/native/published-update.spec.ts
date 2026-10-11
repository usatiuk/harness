import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDiscovery } from "@harness/connections/node";
import { NativeApplication, stopNativeOwners } from "./application.ts";

const execute = promisify(execFile);
test.skip(
  process.platform !== "win32" || !process.env.HARNESS_RELEASE_VERSION,
  "Runs against published installers on the hosted Windows runner",
);
test.afterEach(stopNativeOwners);

test("published desktop installs its signed update and restarts", async ({}, info) => {
  test.setTimeout(180_000);
  const version = process.env.HARNESS_RELEASE_VERSION!;
  const app = await NativeApplication.launch(info.outputPath("profile"), info.outputPath("native"));
  try {
    const offered = await app.page.evaluate(() => {
      const native = window as unknown as {
        __TAURI_INTERNALS__: { invoke<T>(command: string, args: unknown): Promise<T> };
      };
      return native.__TAURI_INTERNALS__.invoke<string>("desktop_update", { version: null });
    });
    expect(offered).toBe(version);
    const installed = app.page
      .evaluate((version) => {
        const native = window as unknown as {
          __TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> };
        };
        return native.__TAURI_INTERNALS__.invoke("desktop_update", { version });
      }, version)
      .catch((error: unknown) => {
        // Windows exits the old process from Tauri's installer hook, closing IPC.
        expect(String(error)).toContain("Target page, context or browser has been closed");
      });
    await Promise.all([installed, app.waitForExit()]);
    await expect
      .poll(
        async () =>
          (
            await execute(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Item -LiteralPath $env:HARNESS_NATIVE_EXECUTABLE).VersionInfo.ProductVersion",
              ],
              { windowsHide: true, timeout: 10_000 },
            )
          ).stdout.trim(),
        { timeout: 60_000 },
      )
      .toBe(version);
    await expect
      .poll(async () => (await readDiscovery(app.home))?.productVersion, { timeout: 60_000 })
      .toBe(version);
  } finally {
    await app.close();
  }
});
