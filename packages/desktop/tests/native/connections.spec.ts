import { expect, test } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { remoteProcessFixture } from "@harness/testkit";
import { canonicalHome, readDiscovery } from "@harness/connections/local";
import { stopServer, runRemote, shellQuote } from "@harness/connections/node";
import type { Host } from "@harness/connections";
import { NativeApplication } from "./application.ts";

test.skip(process.platform !== "win32", "Native CDP requires Windows WebView2");
test("host switcher starts with Local and connection editing survives a disconnected server", async ({}, info) => {
  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  const app = await NativeApplication.launch(profile, info.outputPath("application"), home);
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Selected host" })).toHaveValue("local");
    await page.getByRole("button", { name: "Manage connections" }).click();
    const dialog = page.getByRole("dialog", { name: "Agent command center" });
    await dialog.getByRole("button", { name: "Add SSH" }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Workstation");
    await dialog.getByLabel("SSH destination").fill("user@workstation");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Workstation", exact: true })).toBeVisible();
    await expect
      .poll(
        async (): Promise<unknown> => JSON.parse(await readFile(join(home, "client.json"), "utf8")),
      )
      .toMatchObject({
        selectedHostId: "local",
        hosts: [
          { kind: "local" },
          { kind: "ssh", label: "Workstation", destination: "user@workstation" },
        ],
      });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Manage connections" }).click();
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Local connection" })).toBeVisible();
    await page.getByRole("button", { name: "Manage connections" }).click();
    await expect(dialog.getByRole("button", { name: "Workstation", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    const owner = await readDiscovery(home);
    if (!owner) throw new Error("Missing owner discovery");
    await app.close();
    expect(await NativeApplication.processExists(owner.pid)).toBe(true);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    const owner = await readDiscovery(home);
    if (owner) await stopServer(owner);
  }
});

test("stop-on-exit keeps another client alive and stops only the last local owner", async ({}, info) => {
  const profile = info.outputPath("first-profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  const first = await NativeApplication.launch(profile, info.outputPath("first"), home);
  let second: NativeApplication | undefined;
  try {
    await expect(first.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    const identity = await readDiscovery(home);
    if (!identity) throw new Error("Missing owner");
    second = await NativeApplication.launch(
      info.outputPath("second-profile"),
      info.outputPath("second"),
      home,
    );
    await expect(second.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await first.page.getByRole("button", { name: "Manage connections" }).click();
    const dialog = first.page.getByRole("dialog", { name: "Agent command center" });
    await dialog.getByLabel("Keep the local server running after desktop exit").click();
    await expect(
      dialog.getByLabel("Keep the local server running after desktop exit"),
    ).not.toBeChecked();
    await expect(
      dialog.getByLabel("Keep the local server running after desktop exit"),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await first.close();
    expect(await NativeApplication.processExists(identity.pid)).toBe(true);
    expect((await readDiscovery(home))?.instanceId).toBe(identity.instanceId);
    await second.page.getByRole("link", { name: "New conversation", exact: true }).first().click();
    await expect(second.page.getByRole("heading", { name: "New conversation" })).toBeVisible();
    await second.close();
    expect(await NativeApplication.processExists(identity.pid)).toBe(false);
    expect(await readDiscovery(home)).toBeNull();
  } finally {
    await first.close();
    await second?.close();
    const owner = await readDiscovery(home);
    if (owner) await stopServer(owner);
  }
});

test("stop-on-exit closes a native bridge before its RPC initialization", async ({}, info) => {
  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  const app = await NativeApplication.launch(profile, info.outputPath("application"), home);
  try {
    await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await app.page.getByRole("button", { name: "Manage connections" }).click();
    await app.page.getByLabel("Keep the local server running after desktop exit").click();
    await expect(
      app.page.getByLabel("Keep the local server running after desktop exit"),
    ).toBeEnabled();
    await app.page.evaluate(async () => {
      const api = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            transformCallback(callback: () => void): number;
            invoke(command: string, args: unknown): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      const channel = api.transformCallback(() => undefined);
      await api.invoke("server_connect", {
        channel: `__CHANNEL__:${channel}`,
        host: { id: "local", label: "Local", kind: "local" },
        runtime: null,
      });
    });
    await expect.poll(() => readDiscovery(home)).not.toBeNull();
    const owner = (await readDiscovery(home))!;
    await app.close();
    expect(await NativeApplication.processExists(owner.pid)).toBe(false);
    expect(await readDiscovery(home)).toBeNull();
  } finally {
    await app.close();
    const owner = await readDiscovery(home);
    if (owner) await stopServer(owner);
  }
});

test("desktop cancels a stalled real WSL provisioning process and keeps Local usable", async ({}, info) => {
  const distribution = process.env.HARNESS_REMOTE_WSL;
  test.skip(!distribution, "Set HARNESS_REMOTE_WSL to qualify actual WSL cancellation");
  const remoteRoot = `/tmp/harness-native-cancel-${randomUUID()}`;
  const q = shellQuote;
  const host: Host & { kind: "wsl" } = {
    id: "fixture",
    label: "WSL cancellation",
    kind: "wsl",
    distribution: distribution!,
    user: null,
    runtime: {
      source: "development",
    },
  };
  const script = `#!/bin/sh\nexport HARNESS_FIXTURE_ROOT=${q(remoteRoot)}\nprintf '%s' "$$" > ${q(`${remoteRoot}/pid`)}\nexec sleep 300\n`;
  await test.step(
    "Create isolated WSL process edge",
    () =>
      runRemote(
        host,
        `umask 077; mkdir ${q(remoteRoot)}; printf '%s' ${q(script)} > ${q(`${remoteRoot}/node`)}; chmod 700 ${q(`${remoteRoot}/node`)}`,
        { signal: AbortSignal.timeout(10_000) },
      ),
    { timeout: 12_000 },
  );

  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  const preload = await remoteProcessFixture(
    home,
    `export HOME=${q(remoteRoot)}; export PATH=${q(remoteRoot)}:"$PATH"; `,
  );
  let app: NativeApplication | undefined;
  try {
    app = await test.step(
      "Launch native application",
      () =>
        NativeApplication.launch(profile, info.outputPath("application"), home, profile, {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        }),
      { timeout: 25_000 },
    );

    const page = app.page;
    await test.step(
      "Wait for Local readiness",
      async () => {
        await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
      },
      { timeout: 10_000 },
    );

    const owner = (await readDiscovery(home))!;
    await page.getByRole("button", { name: "Manage connections" }).click({ timeout: 5000 });

    const dialog = page.getByRole("dialog", { name: "Agent command center" });
    await test.step(
      "Discover WSL in editor",
      async () => {
        await dialog.getByRole("button", { name: "Add WSL" }).click({ timeout: 5000 });

        await dialog
          .getByLabel("Distribution", { exact: true })
          .fill(distribution!, { timeout: 5000 });

        await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      },
      { timeout: 10_000 },
    );

    await dialog
      .getByRole("combobox", { name: "Runtime", exact: true })
      .selectOption("development", { timeout: 5000 });

    await dialog.getByRole("button", { name: "Save & test", exact: true }).click();
    await expect
      .poll(() =>
        runRemote(host, `test -f ${q(`${remoteRoot}/pid`)} && printf started || true`, {
          signal: AbortSignal.timeout(5_000),
        }),
      )
      .toBe("started");
    await dialog.getByRole("button", { name: "Cancel connection", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toContainText("cancelled");
    await expect
      .poll(() =>
        runRemote(
          host,
          `pid=$(cat ${q(`${remoteRoot}/pid`)}); if test -r /proc/$pid/environ && tr '\\0' '\\n' < /proc/$pid/environ | grep -Fx ${q(`HARNESS_FIXTURE_ROOT=${remoteRoot}`)} >/dev/null; then printf running; else printf stopped; fi`,
          { signal: AbortSignal.timeout(5_000) },
        ),
      )
      .toBe("stopped");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("link", { name: "New conversation", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
    expect((await readDiscovery(home))?.instanceId).toBe(owner.instanceId);
  } finally {
    await app?.close();
    const owner = await readDiscovery(home);
    if (owner) await stopServer(owner);
    // The fake executable is an isolated process edge; stop only its recorded fixture PID.
    await runRemote(
      host,
      `if test -f ${q(`${remoteRoot}/pid`)}; then pid=$(cat ${q(`${remoteRoot}/pid`)}); if test -r /proc/$pid/environ && tr '\\0' '\\n' < /proc/$pid/environ | grep -Fx ${q(`HARNESS_FIXTURE_ROOT=${remoteRoot}`)} >/dev/null; then kill "$pid"; fi; fi; rm -rf ${q(remoteRoot)}`,
    );
  }
});
