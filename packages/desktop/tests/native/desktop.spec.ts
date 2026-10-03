import { expect, test } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeApplication } from "./application.ts";
import { seedHistory, seedChildOnlyPages, commandProvider } from "./fixtures.ts";

test.skip(process.platform !== "win32", "Native CDP tests require Windows WebView2");

async function profile(directory: string) {
  const home = join(directory, "app");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1", preset: "high" } }),
  );
  return home;
}

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
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    await page.getByLabel("Conversation preset").selectOption("low");
    await expect(page.getByLabel("Conversation preset")).toHaveValue("low");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("beta");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(page.locator(".approval-status")).toHaveCount(2);
    await page.locator(".conversation-list").getByRole("link").filter({ hasText: "alpha" }).click();
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
      "draft kept for alpha",
    );
    await page.getByRole("button", { name: "Stop", exact: true }).click();
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
    await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: /^Theme/u }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
    await page.locator(`a[href='#/conversations/${id}']`).click();
    await expect(page.getByTestId("assistant-message")).toContainText("History loaded");
    await expect(page.getByLabel("Conversation preset")).toHaveValue("high");
    expect(await page.locator(".cell").count()).toBeLessThan(40);
    const tool = page.getByTestId("tool-call");
    await tool.locator("summary").click();
    await expect(tool.locator(".diff-remove")).toContainText("before");
    await expect(tool.locator(".diff-add")).toContainText("after");
    await expect(tool.getByTestId("tool-output")).toContainText("large-output-end");
    await page.screenshot({ path: info.outputPath("diff.png") });
    const scroller = page.locator("[data-virtuoso-scroller]");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const earlier = page.getByRole("button", { name: "Load earlier messages" });
    await expect(earlier).toBeVisible();
    const original = await page.locator(".user-text").first().textContent();
    await earlier.click();
    await expect.poll(() => page.locator(".user-text").first().textContent()).not.toBe(original);
    expect(await page.locator(".cell").count()).toBeLessThan(40);
    await page.getByRole("button", { name: "Jump to latest" }).click();
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
    await expect(rows).toHaveAttribute("href", `#/conversations/${id}`);
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
    await expect(page.locator(".connection-error")).toContainText("server exited");
    await page
      .locator(".connection-error")
      .getByRole("button", { name: "Restart Harness" })
      .click();
    await expect(page.getByTestId("assistant-message")).toContainText("Done");
    await expect(page.locator(".connection-error")).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("quitting stops a real background command and releases the owned server", async ({}, info) => {
  const directory = info.outputPath("profile");
  const marker = join(directory, "command.pid");
  const provider = await commandProvider(
    join(directory, "app"),
    `$PID | Set-Content -LiteralPath '${marker.replace(/'/gu, "''")}'; Write-Output 'command-started'; Start-Sleep -Seconds 300`,
  );
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
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
    await expect.poll(() => NativeApplication.processExists(commandPid)).toBe(false);
    expect(await NativeApplication.processExists(serverPid)).toBe(false);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await provider.close();
  }
});

test("provider keys stay in isolated native storage and configured defaults await restart", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
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
    await expect(
      page.getByRole("combobox", { name: "Model", exact: true }).locator("option:checked"),
    ).toContainText("unavailable");
    await expect(page.getByRole("button", { name: "Create conversation" })).toBeDisabled();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Restart Harness", exact: true }).click();
    await expect(provider).toContainText("Connected");
    await provider.getByRole("button", { name: "Disconnect stored credentials" }).click();
    await expect(provider).toContainText("Stored credentials removed");
    const logs = await readFile(info.outputPath("app", "process.log"), "utf8");
    expect(logs).not.toContain(secret);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
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
    await message.fill("steering input");
    await page.getByRole("combobox", { name: "Delivery" }).selectOption("steer");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator(".pending-input")).toContainText("steering input");
    await message.fill("queued input");
    await page.getByRole("combobox", { name: "Delivery" }).selectOption("queue");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator(".pending-input")).toContainText("queued input");
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

test("a suspended server fails quit observably instead of reporting a clean shutdown", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  await expect(app.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  const serverPid = await app.controlServer("suspend");
  await expect(app.close()).rejects.toThrow("Native process exited unsuccessfully");
  expect(await NativeApplication.processExists(serverPid)).toBe(false);
  expect(await readFile(info.outputPath("app", "process.log"), "utf8")).toContain(
    "did not finish shutdown",
  );
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
    await expect(app.page.getByRole("combobox", { name: /^Sandbox/u })).toHaveValue("native");
    await expect(app.page.getByRole("button", { name: "Create conversation" })).toBeDisabled();
    await app.page.getByRole("combobox", { name: /^Sandbox/u }).selectOption("local");
    await app.page.getByRole("button", { name: "Create conversation" }).click();
    await expect(app.page.getByLabel("Conversation sandbox")).toHaveValue("local");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a second app is rejected by the database lock and can retry after the owner quits", async ({}, info) => {
  const firstDirectory = info.outputPath("first-profile");
  const home = await profile(firstDirectory);
  const first = await NativeApplication.launch(firstDirectory, info.outputPath("first"));
  let second: NativeApplication | undefined;
  try {
    await expect(first.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    second = await NativeApplication.launch(
      info.outputPath("second-profile"),
      info.outputPath("second"),
      home,
    );
    await expect(second.page.getByRole("alert")).toContainText("already running");
    await first.close();
    await second.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(second.page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    expect(second.errors).toEqual([]);
  } finally {
    await second?.close();
    await first.close();
  }
});
