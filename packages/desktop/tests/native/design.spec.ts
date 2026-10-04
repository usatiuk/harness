import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import axe from "axe-core";
import { canonicalHome } from "@harness/connections/node";
import { NativeApplication, stopNativeOwners } from "./application.ts";
import { commandProvider, keepLocalServerRunning } from "./fixtures.ts";
import { showModelControls, manageConnections, settingsSection } from "./controls.ts";
import { accents } from "../../src/preferences.ts";

test.skip(process.platform !== "win32", "Native design qualification requires Windows WebView2");
test.afterEach(stopNativeOwners);

async function profile(directory: string) {
  const home = await canonicalHome(join(directory, "app"));
  await keepLocalServerRunning(home);
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
  );
  return home;
}
async function contrast(page: Page, info: TestInfo, name: string, scope = ".appearance-controls") {
  // Execute through the test debugger; do not weaken the packaged application's CSP.
  await page.evaluate(axe.source);
  await page.locator(scope).scrollIntoViewIfNeeded();
  const result = await page.evaluate(async (scope) => {
    const { axe: analyzer } = window as unknown as { axe: typeof axe };
    return analyzer.run({ include: [scope] }, { runOnly: ["color-contrast"] });
  }, scope);
  await page.screenshot({ path: info.outputPath(`${name}-audit.png`) });
  await info.attach(`${name}-contrast`, {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.violations).toEqual([]);
  expect(result.incomplete).toEqual([]);
}

test("shared controls retain appearance, keyboard preferences and focus in the native app", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  let app = await NativeApplication.launch(directory, info.outputPath("first"));
  try {
    const page = app.page;
    // Prior clients persisted only `theme`; qualification seeds that existing storage edge.
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      await contrast(page, info, theme);
      await page.screenshot({ path: info.outputPath(`${theme.toLowerCase()}-settings.png`) });
    }
    await page.getByRole("button", { name: "Sage", exact: true }).click();
    await settingsSection(page, "Defaults");
    await page.getByRole("combobox", { name: "Auto approver", exact: true }).selectOption("true");
    await settingsSection(page, "Appearance");
    await expect(page.getByRole("combobox", { name: "Auto approver", exact: true })).toHaveCount(0);
    await settingsSection(page, "Defaults");
    await expect(page.getByRole("combobox", { name: "Auto approver", exact: true })).toHaveValue(
      "true",
    );
    await settingsSection(page, "Composer");
    await page.getByLabel("Send message with").selectOption("Shift+Enter");
    await page.getByLabel("While working, default to").selectOption("steer");
    await page.getByLabel("Show last-turn statistics").check();
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.screenshot({ path: info.outputPath("dark-create.png") });
    await page.getByRole("button", { name: "Create conversation" }).click();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("First line");
    await message.press("Enter");
    await expect(message).toHaveValue("First line\n");
    await message.dispatchEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      isComposing: true,
      bubbles: true,
    });
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
    await expect(message).toHaveValue("First line\n");
    await message.press("Shift+Enter");
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Last turn statistics")).toContainText("Input unavailable");
    await showModelControls(page);
    await expect(page.getByLabel("Conversation model")).toBeFocused();
    await page.getByLabel("Conversation model").press("Escape");
    await expect(page.getByLabel("Conversation model")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Model and preset:/u })).toBeFocused();
    await expect(page.getByRole("button", { name: "Appearance", exact: true })).toHaveCount(0);
    await manageConnections(page);
    const connections = page.getByRole("dialog", { name: "Connections" });
    await page.screenshot({ path: info.outputPath("dark-connections.png") });
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Tab");
      expect(await connections.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(
        true,
      );
    }
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Shift+Tab");
      expect(await connections.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(
        true,
      );
    }
    const stopServer = connections.getByRole("button", { name: "Stop server", exact: true });
    await stopServer.click();
    await expect(
      page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(stopServer).toBeFocused();
    await page
      .getByRole("dialog", { name: "Connections" })
      .getByRole("button", { name: "Close dialog" })
      .click();
    await expect(page.getByRole("button", { name: /^Switch host:/u })).toBeFocused();
    await manageConnections(page);
    await page.getByRole("dialog", { name: "Connections" }).press("Escape");
    await expect(page.getByRole("button", { name: /^Switch host:/u })).toBeFocused();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    // CDP viewport plus measured 200% CSS zoom scales fixed-pixel controls too.
    await page.setViewportSize({ width: 720, height: 520 });
    const before = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    const after = await stop.boundingBox();
    expect(after!.height / before!.height).toBeCloseTo(2, 1);
    await message.scrollIntoViewIfNeeded();
    await expect(message).toBeInViewport();
    await stop.scrollIntoViewIfNeeded();
    await expect(stop).toBeInViewport();
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
    await page.screenshot({ path: info.outputPath("dark-chat-minimum.png") });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    await app.close();
    app = await NativeApplication.launch(directory, info.outputPath("reopened"));
    await app.page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(app.page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(app.page.getByRole("button", { name: "Sage", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await settingsSection(app.page, "Composer");
    await expect(app.page.getByLabel("Send message with")).toHaveValue("Shift+Enter");
    await expect(app.page.getByLabel("While working, default to")).toHaveValue("steer");
    await expect(app.page.getByLabel("Show last-turn statistics")).toBeChecked();
    await manageConnections(app.page);
    await app.page
      .getByRole("dialog", { name: "Connections" })
      .getByRole("button", { name: "Stop server", exact: true })
      .click();
    await expect(
      app.page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await app.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Stop server", exact: true })
      .click();
    await expect(app.page.getByRole("alertdialog")).toHaveCount(0);
    await expect(
      app.page
        .getByRole("dialog", { name: "Connections" })
        .getByRole("button", { name: "Done", exact: true }),
    ).toBeFocused();
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("appearance remains legible across accents and follows system accessibility media", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      for (const [label] of accents) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await contrast(page, info, `${theme}-${label}`);
      }
      for (const color of ["#000000", "#ffffff"]) {
        // Control the native chooser's value/event edge without opening an OS color dialog.
        await page.getByLabel("Custom accent").evaluate((input, color) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            input,
            color,
          );
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, color);
        expect(
          await page
            .locator("html")
            .evaluate((root) => (root as HTMLElement).style.getPropertyValue("--accent")),
        ).toBe(color);
        await contrast(page, info, `${theme}-${color}`);
      }
    }
    await page.getByRole("button", { name: "System", exact: true }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    }
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    const selected = page.getByRole("button", { name: "System", exact: true });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(selected.locator(".choice-check")).toBeVisible();
    expect(await selected.evaluate((button) => getComputedStyle(button).transitionDuration)).toBe(
      "0s",
    );
    expect(await selected.evaluate((button) => getComputedStyle(button).borderTopStyle)).toBe(
      "solid",
    );
    await page.screenshot({ path: info.outputPath("forced-colors.png") });
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("startup configuration failure has aligned recovery without premature host controls", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  await writeFile(join(home, "client.json"), "invalid-json");
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await expect(page.getByRole("heading", { name: "Could not start Harness" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Switch host:/u })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("startup-error.png") });
    await rm(join(home, "client.json"));
    await page.getByRole("button", { name: "Retry startup", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Switch host:/u })).toBeEnabled();
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("production page layouts remain coherent in both themes and creation fits scaled windows", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: theme, exact: true }).click();
      for (const section of [
        "Appearance",
        "Defaults",
        "Providers",
        "Composer",
        "Application",
      ] as const) {
        await settingsSection(page, section);
        if (section === "Providers") {
          await contrast(
            page,
            info,
            `${theme}-${section}-heading`,
            '.settings-panel[data-state="active"] .section-heading',
          );
          const count = await page
            .locator('.settings-panel[data-state="active"] > .provider')
            .count();
          for (let index = 0; index < count; index++) {
            await contrast(
              page,
              info,
              `${theme}-provider-${index}`,
              `.settings-panel[data-state="active"] > .provider:nth-of-type(${index + 1})`,
            );
          }
        } else
          await contrast(
            page,
            info,
            `${theme}-${section}-page`,
            '.settings-panel[data-state="active"]',
          );
      }
      await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
      await contrast(page, info, `${theme}-creation`, ".creation-form");
      await page.getByRole("button", { name: /^Switch host:/u }).click();
      await page.getByRole("button", { name: "Manage connections", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Connections", exact: true })).toBeVisible();
      await contrast(page, info, `${theme}-connections`, ".connections-dialog");
      await page
        .getByRole("dialog", { name: "Connections", exact: true })
        .getByRole("button", { name: "Done", exact: true })
        .click();
    }
    await page.setViewportSize({ width: 720, height: 520 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page
      .getByRole("button", { name: "Create conversation", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Create conversation", exact: true }),
    ).toBeInViewport();
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
    await page.screenshot({ path: info.outputPath("dark-creation-minimum.png") });
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("context and last-turn facts come from persisted model accounting and survive reopening", async ({}, info) => {
  const directory = info.outputPath("profile");
  const home = await profile(directory);
  const provider = await commandProvider(home, "Write-Output 'usage-proof'");
  const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as {
    providers: { fixture: { config: { models: Record<string, unknown> } } };
  };
  settings.providers.fixture.config.models["test-model"] = {
    contextWindow: 1000,
    maxOutputTokens: 100,
  };
  await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  let app = await NativeApplication.launch(directory, info.outputPath("first"));
  try {
    let page = app.page;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Composer");
    await page.getByLabel("Show last-turn statistics").check();
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    await page.getByRole("button", { name: "Context usage: unknown", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Context and usage" })).toContainText(
      "No reported agent request yet",
    );
    await page.getByRole("dialog", { name: "Context and usage" }).press("Escape");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Show usage");
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
    await expect(page.getByTestId("assistant-message")).toContainText(
      "Command is running in the background",
    );
    await expect(page.locator(".conversation-status")).toContainText("Ready");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(page.getByLabel("Last turn statistics")).toContainText("20 in");
      await expect(page.getByLabel("Last turn statistics")).toContainText("4 out");
      await expect(page.getByLabel("Last turn statistics")).toContainText(/\d+(?:\.\d+)? tok\/s/u);
      await page.getByRole("button", { name: "Context usage: 1%", exact: true }).click();
      const popup = page.getByRole("dialog", { name: "Context and usage" });
      await expect(popup.locator("dt", { hasText: "Last agent input" }).locator("+ dd")).toHaveText(
        "10",
      );
      await expect(popup.locator("dt", { hasText: "Context capacity" }).locator("+ dd")).toHaveText(
        "1,000",
      );
      await popup.press("Escape");
      if (attempt === 0) {
        await page.screenshot({ path: info.outputPath("chat.png") });
        await app.close();
        app = await NativeApplication.launch(directory, info.outputPath("reopened"));
        page = app.page;
        await page.locator(".conversation-list").getByRole("link").first().click();
      }
    }
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
    await provider.close();
  }
});
