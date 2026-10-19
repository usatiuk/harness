import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { remoteProcessFixture } from "@harness/testkit";
import { canonicalHome, readDiscovery, discoverySchema } from "@harness/connections/local";
import { stopServer, runRemote, shellQuote } from "@harness/connections/node";
import { clientConfigSchema, type Host } from "@harness/connections";
import { NativeApplication } from "./application.ts";
import { expandWorkGroup, manageConnections, switchHost, settingsSection } from "./controls.ts";

test.skip(process.platform !== "win32", "Native CDP requires Windows WebView2");
test("packaged Local starts outside the checkout and reuses its standalone cache", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-native-isolated-"));
  const home = await canonicalHome(join(directory, "home"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
  );
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(
      info.outputPath("profile"),
      info.outputPath("first"),
      home,
      directory,
    );
    await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await app.page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(app.page, "Application");
    await expect(
      app.page.getByLabel("Keep this server running after desktop exit"),
    ).not.toBeChecked();
    await app.page.goBack();
    const first = await readDiscovery(home);
    if (!first) throw new Error("Missing standalone owner discovery");
    expect(app.errors).toEqual([]);
    await app.close();
    await expect.poll(() => NativeApplication.processExists(first.pid)).toBe(false);
    expect(await readDiscovery(home)).toBeNull();
    app = await NativeApplication.launch(
      info.outputPath("reopened-profile"),
      info.outputPath("reopened"),
      home,
      directory,
    );
    await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    const second = await readDiscovery(home);
    if (!second) throw new Error("Missing restarted standalone owner discovery");
    expect(second.buildId).toBe(first.buildId);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(app.errors).toEqual([]);
  } finally {
    await app?.close();
    const owner = await readDiscovery(home);
    if (owner) {
      await stopServer(owner);
      await expect.poll(() => NativeApplication.processExists(owner.pid)).toBe(false);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("host switcher starts with Local and connection editing survives a disconnected server", async ({}, info) => {
  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
  );
  const app = await NativeApplication.launch(profile, info.outputPath("application"), home);
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Switch host: Local", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Application");
    const keepRunning = page.getByLabel("Keep this server running after desktop exit");
    await keepRunning.click();
    await page.getByRole("button", { name: "Save server settings", exact: true }).click();
    await expect
      .poll(async (): Promise<unknown> =>
        JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
      )
      .toMatchObject({ desktop: { keepServerRunning: true } });
    await expect(keepRunning).toBeChecked();
    await expect(keepRunning).toBeEnabled();
    await page.goBack();
    await manageConnections(page);
    const dialog = page.getByRole("dialog", { name: "Connections" });
    await dialog.getByRole("button", { name: "Add SSH" }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Workstation");
    await dialog.getByLabel("SSH destination").fill("user@workstation");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Workstation", exact: true })).toBeVisible();
    await expect
      .poll(async (): Promise<unknown> =>
        JSON.parse(await readFile(join(home, "client.json"), "utf8")),
      )
      .toMatchObject({
        selectedHostId: "local",
        hosts: [
          { kind: "local" },
          { kind: "ssh", label: "Workstation", destination: "user@workstation" },
        ],
      });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await manageConnections(page);
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Local connection" })).toBeVisible();
    await manageConnections(page);
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
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
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
    await first.page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(first.page, "Application");
    await expect(
      first.page.getByLabel("Keep this server running after desktop exit"),
    ).not.toBeChecked();
    await expect(
      first.page.getByLabel("Keep this server running after desktop exit"),
    ).toBeEnabled();
    await first.page.goBack();
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
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
  );
  const app = await NativeApplication.launch(profile, info.outputPath("application"), home);
  try {
    await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await app.page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(app.page, "Application");
    await expect(
      app.page.getByLabel("Keep this server running after desktop exit"),
    ).not.toBeChecked();
    await expect(app.page.getByLabel("Keep this server running after desktop exit")).toBeEnabled();
    await app.page.goBack();
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
  };
  await test.step(
    "Create isolated WSL process edge",
    () =>
      runRemote(host, `umask 077; mkdir ${q(remoteRoot)}`, { signal: AbortSignal.timeout(10_000) }),
    { timeout: 12_000 },
  );

  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
  );
  const preload = await remoteProcessFixture(
    home,
    `export HOME=${q(remoteRoot)}; export HARNESS_FIXTURE_ROOT=${q(remoteRoot)}; printf '%s' "$$" > ${q(`${remoteRoot}/pid`)}; exec sleep 300; `,
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
    await manageConnections(page);

    const dialog = page.getByRole("dialog", { name: "Connections" });
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
    // Stop only the isolated process edge's recorded fixture PID.
    await runRemote(
      host,
      `if test -f ${q(`${remoteRoot}/pid`)}; then pid=$(cat ${q(`${remoteRoot}/pid`)}); if test -r /proc/$pid/environ && tr '\\0' '\\n' < /proc/$pid/environ | grep -Fx ${q(`HARNESS_FIXTURE_ROOT=${remoteRoot}`)} >/dev/null; then kill "$pid"; fi; fi; rm -rf ${q(remoteRoot)}`,
    );
  }
});

test("a real WSL conversation keeps its approval across host switching and desktop exit", async ({}, info) => {
  test.setTimeout(120_000);
  const distribution = process.env.HARNESS_REMOTE_WSL;
  test.skip(!distribution, "Set HARNESS_REMOTE_WSL to qualify remote conversation interaction");
  const remoteRoot = `/tmp/harness-native-work-${randomUUID()}`;
  const remoteHome = `${remoteRoot}/.harness`;
  const host: Host & { kind: "wsl" } = {
    id: "fixture",
    label: "WSL work",
    kind: "wsl",
    distribution: distribution!,
    user: null,
  };
  const q = shellQuote;
  const settings = JSON.stringify({
    version: 1,
    model: { provider: "demo", model: "demo-1" },
    desktop: { keepServerRunning: true },
  });
  await runRemote(
    host,
    `umask 077; mkdir -p ${q(remoteHome)} ${q(`${remoteRoot}/project`)}; printf '%s' ${q(settings)} > ${q(`${remoteHome}/settings.json`)}`,
  );
  const owner = async () =>
    discoverySchema
      .nullable()
      .parse(
        JSON.parse(
          await runRemote(
            host,
            `if test -f ${q(`${remoteHome}/.running-server/discovery.json`)}; then cat ${q(`${remoteHome}/.running-server/discovery.json`)}; else printf null; fi`,
          ),
        ),
      );
  const profile = info.outputPath("profile");
  const home = await canonicalHome(join(profile, "app"));
  await writeFile(join(home, "settings.json"), settings);
  const preload = await remoteProcessFixture(home, `export HOME=${q(remoteRoot)}; `);
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(profile, info.outputPath("first"), home, profile, env);
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await manageConnections(page);
    const dialog = page.getByRole("dialog", { name: "Connections" });
    await dialog.getByRole("button", { name: "Add WSL" }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("WSL work");
    await dialog.getByLabel("Distribution", { exact: true }).fill(distribution!);
    await dialog.getByRole("button", { name: "Save & connect", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible({
      timeout: 60_000,
    });
    const config = clientConfigSchema.parse(
      JSON.parse(await readFile(join(home, "client.json"), "utf8")),
    );
    const remoteId = config.selectedHostId;
    expect(remoteId).not.toBe("local");
    const originalOwner = (await owner())!;
    await page.getByRole("link", { name: "New conversation", exact: true }).first().click();
    await page.getByLabel("Project folder").fill(`${remoteRoot}/project`);
    await page.getByRole("button", { name: "Create conversation", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("remote-work-marker");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("region", { name: "Approval request" })).toContainText(
      "Allow bash?",
    );
    const conversationUrl = page.url();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("remote draft");
    await switchHost(page, "Local");
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await switchHost(page, "WSL work");
    await expect(page.getByRole("region", { name: "Approval request" })).toBeVisible();
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
      "remote draft",
    );
    await app.close();
    expect((await owner())?.instanceId).toBe(originalOwner.instanceId);
    await expect
      .poll(() => runRemote(host, `kill -0 ${originalOwner.pid} && printf running`))
      .toBe("running");
    app = await NativeApplication.launch(profile, info.outputPath("reopened"), home, profile, env);
    await expect(app.page.getByRole("region", { name: "Approval request" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(app.page).toHaveURL(conversationUrl);
    await expect(app.page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
      "remote draft",
    );
    expect((await owner())?.instanceId).toBe(originalOwner.instanceId);
    await app.page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(app.page.getByTestId("assistant-message")).toContainText("Done");
    await expect(app.page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expandWorkGroup(app.page.locator(".tool-group-container").last());
    await app.page.getByTestId("tool-call").locator("summary").click();
    await expect(app.page.getByTestId("tool-output")).toContainText("remote-work-marker");
    expect(app.errors).toEqual([]);
  } finally {
    await app?.close();
    const local = await readDiscovery(home);
    if (local) await stopServer(local);
    const current = await owner();
    if (current) {
      // Stop only the owner whose process environment names this unique fixture.
      await runRemote(
        host,
        `tr '\\0' '\\n' < /proc/${current.pid}/environ | grep -Fx ${q(`HARNESS_HOME=${remoteHome}`)} >/dev/null && kill ${current.pid}`,
      );
      await expect
        .poll(() =>
          runRemote(
            host,
            `if kill -0 ${current.pid} 2>/dev/null; then printf running; else printf stopped; fi`,
          ),
        )
        .toBe("stopped");
    }
    await runRemote(host, `rm -rf ${q(remoteRoot)}`);
  }
});
