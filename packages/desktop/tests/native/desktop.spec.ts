import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deviceAuthFixture } from "@harness/testkit";
import { NativeApplication, stopNativeOwners } from "./application.ts";
import { canonicalHome, readDiscovery, stopServer } from "@harness/connections/node";
import {
  seedHistory,
  seedChildOnlyPages,
  commandProvider,
  streamingProvider,
  keepLocalServerRunning,
} from "./fixtures.ts";
import { httpGateway, json, sse } from "../../../litellm/src/http-fixture.ts";
import { settingsSection, showModelControls, showSandboxControls } from "./controls.ts";

test.skip(process.platform !== "win32", "Native CDP tests require Windows WebView2");
test.afterEach(stopNativeOwners);

test("code-only execution reviews concrete child calls and keeps nested history after reopening", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-native-code-"));
  await mkdir(join(directory, ".harness"));
  const profileRoot = info.outputPath("profile");
  const appProfile = await profile(profileRoot);
  const previousPath = process.env.HARNESS_NATIVE_PATH;
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  process.env.HARNESS_NATIVE_PATH = [
    join(windows, "System32"),
    join(windows, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  let app = await NativeApplication.launch(
    profileRoot,
    info.outputPath("first"),
    appProfile,
    directory,
  );
  try {
    const page = app.page;
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByLabel("Project folder").fill(directory);
    await page.getByRole("button", { name: "Choose execution options" }).click();
    await page.getByLabel("Tool interface").selectOption("code-only");
    await page.getByRole("button", { name: "Create conversation" }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("code-mode-marker");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const approval = page.getByRole("region", { name: "Approval request" });
    await expect(approval).toContainText("Allow powershell?");
    await expect(approval.locator("pre")).toContainText("code-mode-marker");
    await expect(
      page
        .locator('[data-testid="tool-call"]')
        .filter({ has: page.locator("summary strong", { hasText: "tool_search" }) }),
    ).toHaveCount(1);
    const outer = page
      .locator('[data-testid="tool-call"]')
      .filter({ has: page.locator("summary strong", { hasText: "eval" }) })
      .first();
    await outer.locator(":scope > summary").click();
    await expect(outer.locator(".nested-tools")).toContainText("powershell");
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    const nested = outer.locator('.nested-tools [data-testid="tool-call"]');
    await nested.locator("summary").click();
    await expect(nested.getByTestId("tool-output")).toContainText("code-mode-marker");
    await expect(nested).toContainText("Invoked by");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("deny-code-marker");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(approval).toContainText("deny-code-marker");
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await app.close();
    app = await NativeApplication.launch(
      profileRoot,
      info.outputPath("reopened"),
      appProfile,
      directory,
    );
    await app.page.locator(".conversation-list").getByRole("link").first().click();
    const reopened = app.page
      .locator('[data-testid="tool-call"]')
      .filter({ has: app.page.locator("summary strong", { hasText: "eval" }) });
    await expect(reopened).toHaveCount(2);
    await reopened.last().locator(":scope > summary").click();
    await expect(reopened.last().locator(".nested-tools")).toContainText("error");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    if (previousPath === undefined) delete process.env.HARNESS_NATIVE_PATH;
    else process.env.HARNESS_NATIVE_PATH = previousPath;
    await stopNativeOwners();
    await rm(directory, { recursive: true, force: true });
  }
});

async function profile(directory: string) {
  const home = await canonicalHome(join(directory, "app"));
  await keepLocalServerRunning(home);
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1", preset: "high" } }),
  );
  return home;
}

test("floating composer follows a real stream, pauses for reading and resumes from three dots", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const provider = await streamingProvider(home);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByLabel("Project folder").fill(directory);
    await page.getByRole("button", { name: "Create conversation" }).click();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Stream a long answer");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Native stream start");
    const scroll = page.locator(".conversation-scroll");
    const gap = () =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(gap).toBeLessThanOrEqual(4);
    await expect(page.locator(".composer-primary")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    const canvas = await page.locator(".conversation-page").boundingBox();
    expect(await scroll.boundingBox()).toEqual(canvas);
    const content = await page.getByTestId("assistant-message").boundingBox();
    const dock = await page.locator(".conversation-dock").boundingBox();
    expect(content!.y + content!.height).toBeLessThanOrEqual(dock!.y);
    await scroll.evaluate((element) => {
      element.scrollTop -= 350;
    });
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await expect(jump).toBeVisible();
    const top = await scroll.evaluate((element) => element.scrollTop);
    const fade = await page
      .locator(".conversation-dock")
      .evaluate((element) => getComputedStyle(element, "::before").top);
    provider.append("Growth while reading.\n\n".repeat(8));
    await expect(page.getByTestId("assistant-message")).toContainText("Growth while reading");
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
    await jump.click();
    await expect.poll(gap).toBeLessThanOrEqual(4);
    await expect(jump).toHaveCount(0);
    expect(await page.locator(".conversation-dock").boundingBox()).toEqual(dock);
    expect(
      await page
        .locator(".conversation-dock")
        .evaluate((element) => getComputedStyle(element, "::before").top),
    ).toBe(fade);
    provider.append("Growth after jump.\n\n".repeat(8));
    await expect(page.getByTestId("assistant-message")).toContainText("Growth after jump");
    await expect.poll(gap).toBeLessThanOrEqual(4);
    await page.screenshot({ path: info.outputPath("floating-composer.png") });
    provider.finish();
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await scroll.evaluate((element) => {
      element.scrollTop -= 350;
    });
    await expect(jump).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await provider.close();
  }
});

test("two conversations keep independent turns, approvals and drafts; quit resumes history", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  let app = await NativeApplication.launch(directory, info.outputPath("first"));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByLabel("Project folder").fill(directory);
    await page.getByRole("button", { name: "Create conversation" }).click();
    await expect(page).toHaveURL(/#\/conversations\/[^/]+$/u);
    const a = page.url();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("alpha");
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Control+Enter");
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("draft kept for alpha");
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    await expect(page).toHaveURL(/#\/conversations\/[^/]+$/u);
    const b = page.url();
    expect(b).not.toBe(a);
    await showModelControls(page);
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    await showModelControls(page);
    await page.getByLabel("Conversation preset").selectOption("low");
    await showModelControls(page);
    await expect(page.getByLabel("Conversation preset")).toHaveValue("low");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("beta");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(page.locator(".approval-status")).toHaveCount(2);
    await page.locator(".conversation-list").getByRole("link").filter({ hasText: "alpha" }).click();
    await showModelControls(page);
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
      "draft kept for alpha",
    );
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Control+.");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
      "draft kept for alpha",
    );
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
    await expect(page.locator(".approval-status")).toHaveCount(1);
    await page.locator(".conversation-list").getByRole("link").filter({ hasText: "beta" }).click();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Done");
    await page.getByTestId("tool-call").locator("summary").click();
    await expect(page.getByTestId("tool-output")).toContainText("beta");
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await page.screenshot({ path: info.outputPath("conversation.png") });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await settingsSection(page, "Defaults");
    await page.getByLabel("Tools inside the workspace").selectOption("ask");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();
    const saved = JSON.parse(await readFile(join(directory, "app", "settings.json"), "utf8")) as {
      model: { preset: string };
    };
    expect(saved.model.preset).toBe("low");
    expect(app.errors).toEqual([]);
    await app.close();
    app = await NativeApplication.launch(directory, info.outputPath("reopened"));
    await app.page.locator(".conversation-list").getByRole("link").first().click();
    await expect(app.page.getByTestId("assistant-message")).toContainText("Done");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("auto approver model and preset drive real tool review, persist, and can be cleared", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const provider = await commandProvider(home, "Write-Output 'approved-command'", {
    reviewer: true,
  });
  let app = await NativeApplication.launch(directory, info.outputPath("first"));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Defaults");
    await expect(page.getByRole("combobox", { name: "Auto approver", exact: true })).toHaveValue(
      "false",
    );
    await page
      .getByRole("combobox", { name: "Auto approver model", exact: true })
      .selectOption("fixture\u0000reviewer");
    await page
      .getByRole("combobox", { name: "Auto approver preset", exact: true })
      .selectOption("careful");
    await page.getByRole("combobox", { name: "Auto approver", exact: true }).selectOption("true");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Run the command");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Command completed");
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await page.getByTestId("tool-call").locator("summary").click();
    await expect(page.getByTestId("tool-output")).toContainText("approved-command");
    expect(provider.reviews).toHaveLength(1);
    expect(provider.reviews[0]).toMatchObject({ model: "reviewer", temperature: 0.1 });
    const conversation = page.url();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Defaults");
    await page
      .getByRole("combobox", { name: "Auto approver model", exact: true })
      .selectOption("fixture\u0000reviewer-fast");
    await page
      .getByRole("combobox", { name: "Auto approver preset", exact: true })
      .selectOption("quick");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();
    await page.locator(`a[href='${new URL(conversation).hash.slice(1)}']`).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use the new reviewer");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(page.getByTestId("assistant-message").last()).toContainText("Command completed");
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    expect(provider.reviews).toHaveLength(2);
    expect(provider.reviews[1]).toMatchObject({ model: "reviewer-fast", temperature: 0.5 });
    await showModelControls(page);
    await expect(page.getByLabel("Conversation model")).toHaveValue("fixture\u0000test-model");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Defaults");
    await page.getByRole("combobox", { name: "Auto approver", exact: true }).selectOption("false");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();
    await page.locator(`a[href='${new URL(conversation).hash.slice(1)}']`).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Run it again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    expect(provider.reviews).toHaveLength(2);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(app.errors).toEqual([]);
    await app.close();
    app = await NativeApplication.launch(directory, info.outputPath("reopened"));
    await app.page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(app.page, "Defaults");
    await expect(
      app.page.getByRole("combobox", { name: "Auto approver", exact: true }),
    ).toHaveValue("false");
    await expect(
      app.page.getByRole("combobox", { name: "Auto approver model", exact: true }),
    ).toHaveValue("fixture\u0000reviewer-fast");
    await expect(
      app.page.getByRole("combobox", { name: "Auto approver preset", exact: true }),
    ).toHaveValue("quick");
    await app.page
      .getByRole("combobox", { name: "Auto approver model", exact: true })
      .selectOption("");
    await app.page.getByRole("button", { name: "Save defaults" }).click();
    await expect(app.page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();
    const saved = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as {
      model: unknown;
      plugins: Record<string, unknown>;
    };
    expect(saved.plugins["auto-approval"]).toEqual({ enabled: false });
    expect(saved.plugins.approval).toEqual({ inWorkspace: "ask", outOfWorkspace: "ask" });
    expect(saved.model).toEqual({ provider: "fixture", model: "test-model" });
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await provider.close();
  }
});

test("paged sidebar and virtualized history retain preset, diffs and large tool output", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const id = await seedHistory(home, directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    const rows = page.locator(".conversation-list").getByRole("link");
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(rows).toHaveCount(56);
    await page.locator(`a[href='/conversations/${id}']`).click();
    await expect(page.getByTestId("assistant-message")).toContainText("History loaded");
    await showModelControls(page);
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    expect(await page.locator(".cell").count()).toBeLessThan(40);
    const tool = page.getByTestId("tool-call");
    await tool.locator("summary").click();
    await expect(tool.locator(".diff-remove")).toContainText("before");
    await expect(tool.locator(".diff-add")).toContainText("after");
    await expect(tool.getByTestId("tool-output")).toContainText("large-output-end");
    await page.screenshot({ path: info.outputPath("diff.png") });
    const scroller = page.locator(".conversation-scroll");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const earlier = page.getByRole("button", { name: "Load earlier messages" });
    await expect(earlier).toBeVisible();
    const original = await page.locator(".user-text").first().textContent();
    const anchor = page.getByText(original!, { exact: true });
    const anchorTop = (await anchor.boundingBox())!.y;
    const height = await scroller.evaluate((element) => element.scrollHeight);
    await earlier.click();
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(height);
    await expect
      .poll(async () => Math.abs((await anchor.boundingBox())!.y - anchorTop))
      .toBeLessThanOrEqual(1.5);
    expect(await page.locator(".cell").count()).toBeLessThan(40);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByTestId("assistant-message")).toContainText("History loaded");
    await expect(rows).toHaveCount(56);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("child-only sidebar pages advance through revalidation until older roots appear", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const id = await seedChildOnlyPages(home, directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const rows = app.page.locator(".conversation-list").getByRole("link");
    await expect(app.page.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
    for (let page = 0; page < 3; page++) {
      await expect(rows).toHaveCount(0);
      await app.page.getByRole("button", { name: "Load more", exact: true }).click();
      // The next click requires the prior fetcher action/revalidation to finish.
      if (page < 2)
        await expect(
          app.page.getByRole("button", { name: "Load more", exact: true }),
        ).toBeEnabled();
    }
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("href", `/conversations/${id}`);
    await expect(app.page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("server crash is visible and restart recovers the selected conversation", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page
      .getByRole("complementary")
      .getByRole("link", { name: "New conversation", exact: true })
      .click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("survives server crash");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Done");
    await app.crashServer();
    await expect(page.getByRole("heading", { name: "Local connection" })).toBeVisible();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Done");
    await expect(page.getByRole("heading", { name: "Local connection" })).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("quitting keeps a real background command alive until explicit server stop", async ({}, info) => {
  const directory = info.outputPath("profile");
  const marker = join(directory, "command.pid");
  const home = await canonicalHome(join(directory, "app"));
  await keepLocalServerRunning(home);
  const provider = await commandProvider(
    join(directory, "app"),
    `$PID | Set-Content -LiteralPath '${marker.replace(/'/gu, "''")}'; Write-Output 'command-started'; Start-Sleep -Seconds 300`,
  );
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await page
      .getByRole("complementary")
      .getByRole("link", { name: "New conversation", exact: true })
      .click();
    await page.getByLabel("Project folder").fill(directory);
    await page.getByRole("button", { name: "Create conversation" }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("run the background command");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Command is running");
    await expect(page.locator(".activities")).toContainText("1 running");
    await expect
      .poll(async () => {
        try {
          return (await readFile(marker, "utf8")).trim();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        }
      })
      .toMatch(/^\d+$/u);
    const commandPid = Number((await readFile(marker, "utf8")).trim());
    const serverPid = await app.serverPid();
    expect(await NativeApplication.processExists(commandPid)).toBe(true);
    await app.close();
    expect(await NativeApplication.processExists(commandPid)).toBe(true);
    expect(await NativeApplication.processExists(serverPid)).toBe(true);
    const owner = await readDiscovery(app.home);
    if (!owner) throw new Error("Missing fixture owner");
    await stopServer(owner);
    await expect.poll(() => NativeApplication.processExists(commandPid)).toBe(false);
    expect(await NativeApplication.processExists(serverPid)).toBe(false);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await provider.close();
  }
});

test("Local retains browser sign-in and completes cancellable device-code sign-in", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const network = await deviceAuthFixture(home);
  const app = await NativeApplication.launch(directory, info.outputPath("app"), home, directory, {
    NODE_OPTIONS: `--import=${pathToFileURL(network.preload).href}`,
  });
  try {
    const page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Providers");
    const provider = page.locator(".provider").filter({
      has: page.getByRole("heading", {
        name: "ChatGPT / Codex",
        exact: true,
      }),
    });
    const flow = provider.getByRole("combobox", { name: "Sign-in method" });
    await expect(flow).toHaveValue("browser");
    await expect(flow.locator("option")).toHaveText(["Browser sign-in", "Device code"]);
    await flow.selectOption("device");
    await provider.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByLabel("Sign-in URL", { exact: true })).toHaveValue(
      "https://auth.openai.com/codex/device",
    );
    await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue("FIXTURE-CODE");
    await settingsSection(page, "Appearance");
    await expect(page.getByLabel("Sign-in code", { exact: true })).not.toBeVisible();
    await settingsSection(page, "Providers");
    await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue("FIXTURE-CODE");
    await expect.poll(() => readFile(network.polling, "utf8").catch(() => "")).toBe("polling");
    await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await expect.poll(() => readFile(network.cancelled, "utf8").catch(() => "")).toBe("cancelled");
    await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveCount(0);
    await expect(provider.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await writeFile(network.allow, "yes");
    await flow.selectOption("device");
    await provider.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(provider).toContainText("Credentials available");
    await expect(provider).toContainText("device-fixture@example.com");
    const encrypted = await readFile(
      join(directory, "local-appdata", "Harness", "credentials.dpapi"),
    );
    expect(encrypted.includes(Buffer.from(network.refreshToken))).toBe(false);
    expect(await page.locator("body").textContent()).not.toContain(network.refreshToken);
    expect(await readFile(info.outputPath("app", "process.log"), "utf8")).not.toContain(
      network.refreshToken,
    );
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("provider keys stay in isolated native storage and configured defaults await restart", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Providers");
    const provider = page
      .locator(".provider")
      .filter({ has: page.getByRole("heading", { name: "OpenAI (API key)", exact: true }) });
    await provider.getByLabel("OpenAI (API key) API key").fill("invalid-test-key");
    await provider.getByRole("button", { name: "Save key" }).click();
    await expect(provider.getByRole("alert")).toContainText("keys start");
    const secret = "sk-desktop-native-test-only";
    await provider.getByLabel("OpenAI (API key) API key").fill(secret);
    await provider.getByRole("button", { name: "Save key" }).click();
    await expect(provider).toContainText("Signed in");
    await expect(provider.getByLabel("OpenAI (API key) API key")).toHaveValue("");
    expect(await page.locator("body").textContent()).not.toContain(secret);
    const encrypted = await readFile(
      join(directory, "local-appdata", "Harness", "credentials.dpapi"),
    );
    expect(encrypted.includes(Buffer.from(secret))).toBe(false);
    await page
      .getByRole("complementary")
      .getByRole("link", { name: "New conversation", exact: true })
      .click();
    await page.getByRole("button", { name: "Choose model", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Model", exact: true }).locator("option:checked"),
    ).toContainText("unavailable");
    await expect(page.getByRole("button", { name: "Create conversation" })).toBeDisabled();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Providers");
    await settingsSection(page, "Application");
    await page.getByRole("button", { name: "Restart Harness", exact: true }).click();
    await settingsSection(page, "Providers");
    // Credential presence already changed before restart; a populated boot catalog proves completion.
    await expect(provider).toContainText(/ready · [1-9]\d* models/u);
    await expect(provider).toContainText("Credentials available");
    await provider.getByRole("button", { name: "Disconnect stored credentials" }).click();
    await expect(provider).toContainText("Stored credentials removed");
    const logs = await readFile(info.outputPath("app", "process.log"), "utf8");
    expect(logs).not.toContain(secret);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("named gateways isolate native keys and catalogs while retaining unavailable saved selections", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const workKey = "native-work-fixture-key";
  const personalKey = "native-personal-fixture-key";
  const gateway = await httpGateway((req, res) => {
    if (req.path.endsWith("/v1/models"))
      return json(res, { data: [{ id: req.key === workKey ? "coding" : "personal-code" }] });
    if (req.path.endsWith("/model/info"))
      return json(res, {
        data: [
          {
            model_name: req.key === workKey ? "coding" : "personal-code",
            model_info: {
              max_input_tokens: 200000,
              max_output_tokens: 32000,
              supports_reasoning: true,
            },
          },
        ],
      });
    return sse(res, [
      { choices: [{ delta: { content: "Named gateway completed" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
  });
  const selected = { provider: "work", model: "coding" };
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      model: selected,
      providers: {
        work: { type: "litellm", label: "Work gateway", config: { baseUrl: gateway.url } },
        personal: { type: "litellm", label: "Personal gateway", config: { baseUrl: gateway.url } },
      },
    }),
  );
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Providers");
    const work = page
      .locator(".provider")
      .filter({ has: page.getByRole("heading", { name: "Work gateway", exact: true }) });
    const personal = page
      .locator(".provider")
      .filter({ has: page.getByRole("heading", { name: "Personal gateway", exact: true }) });
    await expect(work).toContainText("missing-credentials");
    for (const [row, label, key] of [
      [work, "Work gateway", workKey],
      [personal, "Personal gateway", personalKey],
    ] as const) {
      await row.getByLabel(`${label} API key`).fill(key);
      await row.getByRole("button", { name: "Save key", exact: true }).click();
      await expect(row).toContainText("Signed in");
      await expect(row.getByLabel(`${label} API key`)).toHaveValue("");
    }
    expect(
      (JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as { model: unknown }).model,
    ).toEqual(selected);
    expect(gateway.requests).toHaveLength(0);
    const ciphertext = await readFile(
      join(directory, "local-appdata", "Harness", "credentials.dpapi"),
    );
    for (const key of [workKey, personalKey]) {
      expect(ciphertext.includes(Buffer.from(key))).toBe(false);
      expect(await page.locator("body").textContent()).not.toContain(key);
    }
    await work.getByRole("button", { name: "Restart Harness", exact: true }).click();
    await settingsSection(page, "Providers");
    await expect(work).toContainText("ready · 1 models");
    await expect(personal).toContainText("ready · 1 models");
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    const picker = page.getByRole("combobox", { name: "Model", exact: true });
    await page.getByRole("button", { name: "Choose model", exact: true }).click();
    await expect(picker.locator("option:checked")).toContainText("Work gateway");
    await expect(picker.locator("option:checked")).toContainText("200,000 input");
    await expect(picker.locator("option:checked")).toContainText("32,000 output");
    await expect(picker.locator("option:checked")).toContainText("reasoning");
    await expect(picker).toHaveValue("work\u0000coding");
    await page.getByLabel("Project folder").fill(directory);
    await page.getByRole("button", { name: "Create conversation" }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use work connection");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Named gateway completed");
    const conversationUrl = page.url();
    expect(
      gateway.requests
        .filter((req) => req.body.model === "coding")
        .every((req) => req.key === workKey),
    ).toBe(true);
    expect(gateway.requests.some((req) => req.body.model === "coding")).toBe(true);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Providers");
    await work.getByRole("button", { name: "Disconnect stored credentials" }).click();
    await expect(work).toContainText("Stored credentials removed");
    await work.getByRole("button", { name: "Restart Harness", exact: true }).click();
    await settingsSection(page, "Providers");
    await expect(work).toContainText("missing-credentials");
    await expect(personal).toContainText("Credentials available");
    await expect(personal).toContainText("ready · 1 models");
    await page.locator(`a[href='${new URL(conversationUrl).hash.slice(1)}']`).click();
    await showModelControls(page);
    await expect(page.getByLabel("Conversation model")).toHaveValue("work\u0000coding");
    await showModelControls(page);
    await expect(page.getByLabel("Conversation model").locator("option:checked")).toContainText(
      "unavailable",
    );
    await expect(page.getByTestId("assistant-message")).toContainText("Named gateway completed");
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByRole("button", { name: "Choose model", exact: true }).click();
    await expect(picker).toHaveValue("work\u0000coding");
    await expect(picker.locator("option:checked")).toContainText("unavailable");
    await expect(page.getByRole("button", { name: "Create conversation" })).toBeDisabled();
    expect(
      (JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as { model: unknown }).model,
    ).toEqual(selected);
    const logs = await readFile(info.outputPath("app", "process.log"), "utf8");
    for (const key of [workKey, personalKey]) expect(logs).not.toContain(key);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await gateway.close();
  }
});

test("queue and steer submit through the data action while a turn waits for approval", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page
      .getByRole("complementary")
      .getByRole("link", { name: "New conversation", exact: true })
      .click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("original input");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(page.locator(".composer-primary")).toHaveText("Stop");
    await message.press("Enter");
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await message.fill("steering input");
    await expect(page.locator(".composer-primary")).toHaveText("Steer");
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await expect(page.locator(".pending-input")).toContainText("steer: steering input");
    await message.fill("queued input");
    await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
    await message.press("Control+Enter");
    await expect(page.locator(".pending-input")).toContainText("queue: queued input");
    for (let count = 0; count < 3; count++) {
      await page.getByRole("button", { name: "Allow", exact: true }).click();
      if (count < 2)
        await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    }
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await expect(page.locator(".pending-input")).toHaveCount(0);
    await expect(page.locator(".user-text")).toHaveText([
      "original input",
      "steering input",
      "queued input",
    ]);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("quitting detaches from a suspended background owner without stopping it", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  const serverPid = await app.controlServer("suspend");
  try {
    await app.close();
    expect(await NativeApplication.processExists(serverPid)).toBe(true);
  } finally {
    await app.controlServer("resume");
    await app.close();
  }
});

test("an unsupported sandbox default stays visible and requires an explicit supported choice", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      model: { provider: "demo", model: "demo-1" },
      plugins: { sandbox: { backend: "native" } },
    }),
  );
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    await app.page
      .getByRole("complementary")
      .getByRole("link", { name: "New conversation" })
      .click();
    await app.page.getByRole("button", { name: "Choose execution options" }).click();
    await expect(app.page.getByRole("combobox", { name: /^Sandbox/u })).toHaveValue("native");
    await expect(app.page.getByRole("button", { name: "Create conversation" })).toBeDisabled();
    await app.page.getByRole("combobox", { name: /^Sandbox/u }).selectOption("local");
    await app.page.getByRole("button", { name: "Create conversation" }).click();
    await showSandboxControls(app.page);
    await expect(app.page.getByLabel("Conversation sandbox")).toHaveValue("local");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a second app reuses the same owner and remains usable after the first quits", async ({}, info) => {
  const firstDirectory = info.outputPath("first-profile");
  const home = await profile(firstDirectory);
  const first = await NativeApplication.launch(firstDirectory, info.outputPath("first"));
  let second: NativeApplication | undefined;
  try {
    await expect(first.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    const ownerPid = await first.serverPid();
    second = await NativeApplication.launch(
      info.outputPath("second-profile"),
      info.outputPath("second"),
      home,
    );
    await expect(second.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    expect(await second.serverPid()).toBe(ownerPid);
    await first.close();
    expect(await second.serverPid()).toBe(ownerPid);
    await expect(second.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    expect(second.errors).toEqual([]);
  } finally {
    await second?.close();
    await first.close();
  }
});
