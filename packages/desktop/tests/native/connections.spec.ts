import { expect, test } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHome, readDiscovery } from "@harness/connections/local";
import { stopServer } from "@harness/connections/node";
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

test("stop-on-exit captures Local startup before any WebView RPC initialization", async ({}, info) => {
  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  const startingHome = await canonicalHome(info.outputPath("starting-home"));
  for (const path of [home, startingHome])
    await writeFile(
      join(path, "settings.json"),
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
    await app.page.evaluate(async (path) => {
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
        host: { id: "local", label: "Local", kind: "local", home: path },
        runtime: null,
      });
    }, startingHome);
    await expect.poll(() => readDiscovery(startingHome)).not.toBeNull();
    const owner = (await readDiscovery(startingHome))!;
    await app.close();
    expect(await NativeApplication.processExists(owner.pid)).toBe(false);
    expect(await readDiscovery(startingHome)).toBeNull();
  } finally {
    await app.close();
    for (const path of [home, startingHome]) {
      const owner = await readDiscovery(path);
      if (owner) await stopServer(owner);
    }
  }
});
