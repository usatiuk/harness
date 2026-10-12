import { chooseDropdown } from "../dropdown.ts";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
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
    JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
  );
  return home;
}
async function nativeTheme(page: Page): Promise<string> {
  return page.evaluate(() => {
    const native = window as unknown as {
      __TAURI_INTERNALS__: { invoke<T>(command: string, args?: unknown): Promise<T> };
    };
    return native.__TAURI_INTERNALS__.invoke<string>("plugin:window|theme", { label: "main" });
  });
}
async function nativeAppearance(
  app: NativeApplication,
  info: TestInfo,
  name: string,
  args: string[] = [],
) {
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("tests/native/window-appearance.ps1"),
      "-TargetProcess",
      String(app.pid),
      "-Screenshot",
      info.outputPath(`${name}-window.png`),
      ...args,
    ],
    { windowsHide: true },
  );
  await writeFile(info.outputPath(`${name}-native.json`), stdout);
  return JSON.parse(stdout) as {
    dark: boolean;
    material: boolean;
    resize: boolean;
    systemMenu: boolean;
    snapHit: number | null;
    menuOpen: boolean;
    left: number;
    top: number;
    width: number;
    height: number;
  };
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
    await expect(page.locator("html")).toHaveAttribute("data-native-material", /^(true|false)$/u);
    const systemTheme = await nativeTheme(page);
    const surfaces = await page.evaluate(() => ({
      material: document.documentElement.dataset.nativeMaterial === "true",
      root: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      sidebar: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor,
      content: getComputedStyle(document.querySelector("main")!).backgroundColor,
    }));
    expect(surfaces.sidebar === "rgba(0, 0, 0, 0)").toBe(surfaces.material);
    expect(surfaces.root === "rgba(0, 0, 0, 0)").toBe(surfaces.material);
    expect(surfaces.body === "rgba(0, 0, 0, 0)").toBe(surfaces.material);
    expect(surfaces.content).not.toBe("rgba(0, 0, 0, 0)");
    // Prior clients persisted only `theme`; qualification seeds that existing storage edge.
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => nativeTheme(page)).toBe("dark");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      await page.emulateMedia({ colorScheme: theme === "Light" ? "dark" : "light" });
      await expect.poll(() => nativeTheme(page)).toBe(theme.toLowerCase());
      const captionColors = await page.evaluate(() => ({
        title: getComputedStyle(document.querySelector(".window-drag-region")!).color,
        control: getComputedStyle(
          document.querySelector('[data-tauri-decoration-control="minimize"]')!,
        ).color,
      }));
      expect(captionColors.control).toBe(captionColors.title);
      const close = page.locator('[data-tauri-decoration-control="close"]');
      await close.hover();
      expect(
        await close.evaluate((button) => ({
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
        })),
      ).toEqual({ color: "rgb(255, 255, 255)", background: "rgb(196, 43, 28)" });
      await page.locator(".window-drag-region").hover({ position: { x: 300, y: 16 } });
      const native = await nativeAppearance(app, info, theme.toLowerCase());
      expect(native.dark).toBe(theme === "Dark");
      expect(native.material).toBe(surfaces.material);
      // Tao retains WS_CAPTION for native frame behavior and removes its painted
      // title bar through WM_NCCALCSIZE. Check the public decoration state.
      expect(
        await page.evaluate(() => {
          const native = window as unknown as {
            __TAURI_INTERNALS__: { invoke<T>(command: string, args?: unknown): Promise<T> };
          };
          return native.__TAURI_INTERNALS__.invoke<boolean>("plugin:window|is_decorated", {
            label: "main",
          });
        }),
      ).toBe(false);
      expect(native.resize).toBe(true);
      expect(native.systemMenu).toBe(true);
      await contrast(page, info, theme);
      await page.screenshot({ path: info.outputPath(`${theme.toLowerCase()}-settings.png`) });
      await manageConnections(page);
      const dimming = await page.evaluate(() => {
        const title = document.querySelector(".window-titlebar")!;
        const overlay = document.querySelector(".overlay")!;
        return {
          height: title.getBoundingClientRect().height,
          top: overlay.getBoundingClientRect().top,
          header: getComputedStyle(title, "::after").backgroundColor,
          content: getComputedStyle(overlay).backgroundColor,
        };
      });
      expect(dimming.top).toBe(dimming.height);
      expect(dimming.header).toBe(dimming.content);
      await nativeAppearance(app, info, `${theme.toLowerCase()}-modal`);
      await page.getByRole("dialog", { name: "Connections" }).press("Escape");
    }
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect.poll(() => nativeTheme(page)).toBe(systemTheme);
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(() => nativeTheme(page)).toBe("dark");
    await page.getByRole("button", { name: "Sage", exact: true }).click();
    await settingsSection(page, "Defaults");
    await chooseDropdown(
      page,
      page.getByRole("combobox", { name: "Auto approver", exact: true }),
      "true",
    );
    await settingsSection(page, "Appearance");
    await expect(page.getByRole("combobox", { name: "Auto approver", exact: true })).toHaveCount(0);
    await settingsSection(page, "Defaults");
    await expect(
      page.getByRole("combobox", { name: "Auto approver", exact: true }),
    ).toHaveAttribute("data-value", "true");
    await settingsSection(page, "Composer");
    await chooseDropdown(page, page.getByLabel("Send message with"), "Shift+Enter");
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
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
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
    await expect(page.locator('.overlay[data-state="open"]')).toHaveCount(2);
    const scrims = await page
      .locator('.overlay[data-state="open"]')
      .evaluateAll((overlays) =>
        overlays.map((overlay) => getComputedStyle(overlay).backgroundColor),
      );
    expect(scrims).toHaveLength(2);
    expect(scrims.filter((color) => color !== "rgba(0, 0, 0, 0)")).toHaveLength(1);
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
    await expect.poll(() => nativeTheme(app.page)).toBe("dark");
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
    await expect(app.page.getByLabel("While working, default to")).toHaveCount(0);
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

test("shared title bar preserves native window behavior and modal navigation state", async ({}, info) => {
  const directory = info.outputPath("profile");
  await profile(directory);
  const app = await NativeApplication.launch(directory, info.outputPath("app"));
  try {
    const page = app.page;
    await expect(page.locator("html")).toHaveAttribute("data-window-decoration", "windows");
    await expect(page.locator(".window-titlebar .lucide-terminal")).toBeVisible();
    await page.getByRole("complementary").getByRole("link", { name: "New conversation" }).click();
    await page.getByRole("button", { name: "Create conversation" }).click();
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("A draft retained through window interactions");
    const route = page.url();
    const state = (kind: "is_maximized" | "is_minimized") =>
      page.evaluate((kind) => {
        const native = window as unknown as {
          __TAURI_INTERNALS__: { invoke<T>(command: string, args?: unknown): Promise<T> };
        };
        return native.__TAURI_INTERNALS__.invoke<boolean>(`plugin:window|${kind}`, {
          label: "main",
        });
      }, kind);
    const first = await nativeAppearance(app, info, "frame");
    expect((await nativeAppearance(app, info, "system-menu", ["-Action", "Menu"])).menuOpen).toBe(
      true,
    );
    await nativeAppearance(app, info, "menu-closed", ["-Action", "Escape"]);
    const moved = await nativeAppearance(app, info, "dragged", ["-Action", "Drag"]);
    expect(moved.left).not.toBe(first.left);
    expect(moved.top).not.toBe(first.top);
    const resized = await nativeAppearance(app, info, "resized", ["-Action", "Resize"]);
    expect(resized.width).toBe(moved.width + 40);
    expect(resized.height).toBe(moved.height + 20);
    const maximize = page.locator('[data-tauri-decoration-control="maximize"]');
    const bounds = (await maximize.boundingBox())!;
    const snap = await nativeAppearance(app, info, "snap", [
      "-ProbeX",
      String(bounds.x + bounds.width / 2),
      "-ProbeY",
      String(bounds.y + bounds.height / 2),
    ]);
    expect(snap.snapHit).toBe(9); // Native HTMAXBUTTON, which Windows uses for Snap.
    await page.locator(".window-drag-region").dblclick({ position: { x: 300, y: 16 } });
    await expect.poll(() => state("is_maximized")).toBe(true);
    await expect(maximize).toHaveAttribute("aria-label", "Restore window size");
    await maximize.click();
    await expect.poll(() => state("is_maximized")).toBe(false);
    await manageConnections(page);
    await maximize.click();
    await expect.poll(() => state("is_maximized")).toBe(true);
    await expect(page.getByRole("dialog", { name: "Connections" })).toBeVisible();
    await page.locator('[data-tauri-decoration-control="minimize"]').click();
    await expect.poll(() => state("is_minimized")).toBe(true);
    await nativeAppearance(app, info, "restored-modal", ["-Action", "Restore"]);
    await expect.poll(() => state("is_minimized")).toBe(false);
    await expect(page.getByRole("dialog", { name: "Connections" })).toBeVisible();
    await page.getByRole("dialog", { name: "Connections" }).press("Escape");
    await expect(draft).toHaveValue("A draft retained through window interactions");
    expect(page.url()).toBe(route);
    expect(app.errors).toEqual([]);
    await page.locator('[data-tauri-decoration-control="close"]').click();
    await app.waitForExit();
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
    await expect(page.locator(".window-titlebar")).toBeVisible();
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
      "No usage reported yet.",
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
