import { chooseDropdown } from "../dropdown.ts";
import { test, expect, type Page } from "@playwright/test";
import { build } from "vite";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

let server: Server;
let url: string;
test.beforeAll(async () => {
  const result = await build({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    logLevel: "error",
    build: {
      write: false,
      rollupOptions: { input: fileURLToPath(new URL("fixture.ts", import.meta.url)) },
    },
  });
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Unexpected fixture build output");
  const assets = new Map(
    result.output.map((asset) => [
      "/" + asset.fileName,
      asset.type === "chunk" ? asset.code : asset.source,
    ]),
  );
  const entry = result.output.find((asset) => asset.type === "chunk" && asset.isEntry);
  if (!entry) throw new Error("Fixture entry is missing");
  const css = result.output
    .filter((asset) => asset.fileName.endsWith(".css"))
    .map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`)
    .join("");
  server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<html><head><meta charset="utf-8">${css}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`,
      );
    } else {
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(assets.get(path));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
test.beforeEach(async ({ page }) => {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => window.canvasFixture.ready)).toBe(true);
  await expect(page.locator(".cell.assistant")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollHeight > 2 * element.clientHeight),
    )
    .toBe(true);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
});
const gap = (page: Page) =>
  page
    .locator(".conversation-scroll")
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

test("running turns show Working before their first agent output", async ({ page }) => {
  await page.goto(url + "?composer");
  const pending = page.getByRole("status").filter({ hasText: /^Working$/ });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(pending).toBeVisible();
  await page.evaluate(() => window.composerFixture.showLivePreview());
  await expect(pending).toHaveCount(0);
  await expect(page.locator(".tool-group-container")).toContainText("Working for");
  await page.evaluate(() => window.composerFixture.completeSteps());
  await expect(page.locator(".tool-group-container")).toContainText("Worked for");
  await expect(pending).toHaveCount(0);
  await page.reload();
  await expect(pending).toBeVisible();
  await page.evaluate(() => window.composerFixture.completeSteps("aborted"));
  await expect(pending).toHaveCount(0);
});

for (const chrome of ["native", "fullscreen"] as const) {
  test(`${chrome} chrome keeps the view full height and Settings at the sidebar bottom`, async ({
    page,
  }) => {
    await page.goto(url + "?composer");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator("main")).toHaveCSS("border-top-left-radius", "12px");
    await page.evaluate((chrome) => {
      if (chrome === "native") document.documentElement.dataset.windowDecoration = "native";
      else document.body.setAttribute("data-tauri-decoration-fullscreen", "");
    }, chrome);
    await expect(page.locator(".window-titlebar")).toBeHidden();
    await expect(page.locator("main")).toHaveCSS("border-top-left-radius", "0px");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const content = document.querySelector(".window-content")!;
          const main = document.querySelector("main")!;
          const sidebar = document.querySelector(".sidebar")!;
          const settings = document.querySelector(".settings-link")!;
          return {
            contentGap: Math.abs(content.getBoundingClientRect().height - innerHeight),
            mainGap: Math.abs(main.getBoundingClientRect().height - innerHeight),
            settingsGap: Math.abs(
              sidebar.getBoundingClientRect().bottom -
                settings.getBoundingClientRect().bottom -
                parseFloat(getComputedStyle(sidebar).paddingBottom),
            ),
          };
        }),
      )
      .toEqual({ contentGap: 0, mainGap: 0, settingsGap: 0 });
  });
}

test("desktop updates capture the offered version and expose installation errors", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { version: string | null }) => {
          if (command !== "desktop_update") throw new Error("Unexpected command");
          if (args.version === null) return "0.2.0";
          if (args.version !== "0.2.0") throw new Error("Offered version was not retained");
          throw new Error("Download interrupted; check again to retry.");
        },
      },
    });
  });
  await page.goto(url + "?updates");
  await expect(page.getByRole("button", { name: /Install/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByRole("status")).toHaveText("Version 0.2.0 is available.");
  await page.getByRole("button", { name: "Install 0.2.0 and restart" }).click();
  await expect(page.getByRole("status")).toHaveText("Download interrupted; check again to retry.");
  await expect(page.getByRole("button", { name: /Install/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByRole("button", { name: "Install 0.2.0 and restart" })).toBeVisible();
});

test("a new tall stream follows from an initially empty conversation", async ({ page }) => {
  await page.goto(url + "?empty");
  await expect.poll(() => page.evaluate(() => window.canvasFixture.ready)).toBe(true);
  await expect
    .poll(() => page.locator(".transcript-clearance").evaluate((element) => element.clientHeight))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.canvasFixture.start());
  // The first user row is attached while the virtualizer's initial alignment is
  // pending; a fast provider can already stream the next row in that interval.
  await expect(page.locator(".user-text")).toBeAttached();
  await page.evaluate(() => window.canvasFixture.appendAssistant());
  await expect(page.locator(".cell.assistant")).toContainText("Latest");
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
});

test("opens at the real bottom of a tall final message and follows same-item growth", async ({
  page,
}) => {
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  const content = await page.locator(".cell.assistant").boundingBox();
  const dock = await page.locator(".conversation-dock").boundingBox();
  expect(content!.y + content!.height).toBeLessThanOrEqual(dock!.y);
  await page.screenshot({ path: test.info().outputPath("floating-light.png") });
  await page.evaluate(() => window.canvasFixture.grow());
  await expect(page.locator(".cell.assistant")).toContainText("Additional streaming paragraph");
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
});

test("reading pauses follow, three-dot jump resumes it without changing dock/fade geometry", async ({
  page,
}) => {
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop -= 450;
  });
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("floating-reading.png") });
  const top = await page.locator(".conversation-scroll").evaluate((element) => element.scrollTop);
  const dock = await page.locator(".conversation-dock").boundingBox();
  const fade = await page
    .locator(".conversation-dock")
    .evaluate((element) => getComputedStyle(element, "::before").top);
  await page.evaluate(() => window.canvasFixture.grow());
  await expect(page.locator(".cell.assistant")).toContainText("Additional streaming paragraph");
  expect(
    await page.locator(".conversation-scroll").evaluate((element) => element.scrollTop),
  ).toBeCloseTo(top, 0);
  await jump.click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await expect(jump).toHaveCount(0);
  expect(await page.locator(".conversation-dock").boundingBox()).toEqual(dock);
  expect(
    await page
      .locator(".conversation-dock")
      .evaluate((element) => getComputedStyle(element, "::before").top),
  ).toBe(fade);
  await page.evaluate(() => window.canvasFixture.grow());
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
});

test("expanding the latest tool retains follow and keeps its output clear of the dock", async ({
  page,
}) => {
  await page.evaluate(() => window.canvasFixture.appendTool());
  const tool = page.locator("details").filter({ hasText: "Latest tool" });
  await expect(tool.locator("summary")).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tool.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  const work = page.locator(".tool-group-container").filter({ has: tool });
  const viewport = await work.boundingBox();
  const dock = await page.locator(".conversation-dock").boundingBox();
  expect(viewport!.y + viewport!.height).toBeLessThanOrEqual(dock!.y);
  expect(await work.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("idle conversations hide jump and history regrouping preserves a visible reading anchor", async ({
  page,
}) => {
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.evaluate(() => window.canvasFixture.setRunning(false));
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  const before = await page.locator(".conversation-scroll").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const visible = [...element.querySelectorAll(".user-text")].find(
      (row) => row.getBoundingClientRect().top >= top,
    );
    if (!visible?.textContent) throw new Error("No visible user message to anchor");
    const anchor = { text: visible.textContent, y: visible.getBoundingClientRect().top };
    window.canvasFixture.prepend();
    return anchor;
  });
  const anchor = page.getByText(before.text, { exact: true });
  // Capture and prepend together so virtualizer measurements cannot stale the baseline.
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before.y))
    .toBeLessThanOrEqual(1.5);
  expect(await page.locator(".transcript-item").count()).toBeLessThan(40);
});

test("support and composer growth keep controls reachable and latest clear of the dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await page.evaluate(() => window.canvasFixture.setSupport(true));
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await page.getByRole("textbox", { name: "Message" }).fill("A long draft\n".repeat(20));
  // A bottom gap can still be zero while the footer has the old dock height.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dock = document.querySelector<HTMLElement>(".conversation-dock-content")!;
        const footer = document.querySelector<HTMLElement>(".transcript-clearance")!;
        return footer.clientHeight - (dock.offsetHeight + 12);
      }),
    )
    .toBe(0);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector(".cell.assistant")!.getBoundingClientRect().bottom -
          document.querySelector(".conversation-dock")!.getBoundingClientRect().top,
      ),
    )
    .toBeLessThanOrEqual(0);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({ path: test.info().outputPath("floating-dark-minimum.png") });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await page.getByRole("button", { name: "Stop", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport();
  // Synthetic CSS zoom qualifies reachability, not Virtuoso's scroll coordinates.
  const clearance = await page
    .locator(".conversation-dock-content")
    .evaluate((element: HTMLElement) => element.offsetHeight + 12);
  expect(
    await page.locator(".transcript-clearance").evaluate((element) => element.clientHeight),
  ).toBe(clearance);
});

test("support growth while reading does not resume follow", async ({ page }) => {
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop -= 450;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const top = await page.locator(".conversation-scroll").evaluate((element) => element.scrollTop);
  await page.setViewportSize({ width: 720, height: 520 });
  await page.evaluate(() => window.canvasFixture.setSupport(true));
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await page.evaluate(() => window.canvasFixture.grow());
  await expect(page.locator(".cell.assistant")).toContainText("Additional streaming paragraph");
  expect(
    await page.locator(".conversation-scroll").evaluate((element) => element.scrollTop),
  ).toBeCloseTo(top, 0);
});

test("a visible child keeps its position when earlier history loads its parent", async ({
  page,
}) => {
  await page.goto(url + "?children");
  await expect.poll(() => page.evaluate(() => window.canvasFixture.ready)).toBe(true);
  await expect(
    page.getByText("History 79: representative discussion", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollHeight > 2 * element.clientHeight),
    )
    .toBe(true);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator(".cell.tool").first()).toBeVisible();
  await page.locator(".cell.tool").first().locator("summary").click();
  await page.locator(".conversation-scroll").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const child = [...element.querySelectorAll(".transcript-item")].find(
      (row) => row.querySelector(".cell.tool") && row.getBoundingClientRect().bottom > top,
    );
    if (!child) throw new Error("No child to read");
    element.scrollTop += child.getBoundingClientRect().top - top + 4;
  });
  await expect
    .poll(() =>
      page.locator(".conversation-scroll").evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const bottom = document.querySelector(".conversation-dock")!.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll(".transcript-item")].filter(
          (row) =>
            row.getBoundingClientRect().bottom > top && row.getBoundingClientRect().top < bottom,
        );
        return (
          visible.length > 0 && visible.every((row) => Boolean(row.querySelector(".cell.tool")))
        );
      }),
    )
    .toBe(true);
  const anchor = await page.locator(".conversation-scroll").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const visible = [...element.querySelectorAll(".cell.tool")].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    if (!visible) throw new Error("No visible child to anchor");
    return {
      name: visible.querySelector("summary")!.textContent,
      y: visible.getBoundingClientRect().top,
    };
  });
  expect(anchor.name).toMatch(/^Child /);
  await page.evaluate(() => window.canvasFixture.prepend());
  const child = page.getByText(anchor.name, { exact: true }).locator("..");
  await expect(child).toBeInViewport();
  await expect
    .poll(async () => Math.abs((await child.boundingBox())!.y - anchor.y))
    .toBeLessThanOrEqual(1.5);
});

test("production model picker distinguishes same-label IDs and exposes advertised presets", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("button", { name: "Model and preset: Fixture model" }).click();
  const models = page.getByRole("combobox", { name: "Conversation model" });
  await models.click();
  await expect(page.getByRole("option")).toHaveText([
    "fixture / Fixture model test",
    "fixture / Fixture model test-latest",
  ]);
  const first = page.getByRole("option", { name: "fixture / Fixture model test", exact: true });
  await first.hover();
  await expect(page.getByRole("tooltip")).toContainText("Images: supported");
  await expect(page.getByRole("tooltip")).toContainText("262,144 context tokens");
  await expect(page.getByRole("tooltip")).toContainText("Presets: none, high");
  expect(
    await first.locator(".model-id").evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(await first.evaluate((element) => getComputedStyle(element).color));
  await page
    .getByRole("option", { name: "fixture / Fixture model test-latest", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toContainText("Images: unsupported");
  await first.click();
  await page.getByRole("combobox", { name: "Conversation preset" }).click();
  await expect(page.getByRole("option")).toHaveText(["Default", "none", "high"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  const preset = page.getByRole("combobox", { name: "New conversation preset" });
  await preset.click();
  await expect(page.getByRole("option")).toHaveText(["Default", "none", "high"]);
  await page.keyboard.press("Escape");
  await chooseDropdown(page, preset, "high");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.creations.at(-1)))
    .toMatchObject({
      overrides: { model: { provider: "fixture", model: "test", preset: "high" } },
    });
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await chooseDropdown(page, preset, "high");
  const newModels = page.getByRole("combobox", { name: "New conversation model" });
  await newModels.click();
  await page
    .getByRole("option", { name: "fixture / Fixture model test-latest", exact: true })
    .click();
  await expect(preset).toHaveCount(0);
  await newModels.click();
  await page.getByRole("option", { name: "fixture / Fixture model test", exact: true }).click();
  await expect(preset).toHaveAttribute("data-value", "");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.creations.at(-1)?.overrides?.model))
    .toEqual({ provider: "fixture", model: "test" });
});

test("new conversation choices become host defaults for the next creation", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await chooseDropdown(
    page,
    page.getByRole("combobox", { name: "New conversation preset" }),
    "high",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Choose execution options" }).click();
  const sandbox = page.getByRole("combobox", { name: "Sandbox", exact: true });
  await expect(sandbox).toHaveAttribute("data-value", "none");
  await sandbox.click();
  await expect(page.getByRole("option", { name: "None", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Local", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Tool interface", exact: true }).click();
  await expect(page.getByRole("option")).toHaveText(["Hybrid", "Code only"]);
  await page.keyboard.press("Escape");
  await chooseDropdown(
    page,
    page.getByRole("combobox", { name: "Sandbox", exact: true }),
    "docker",
  );
  await chooseDropdown(
    page,
    page.getByRole("combobox", { name: "Tool interface", exact: true }),
    "hybrid",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toEqual({
      model: { provider: "fixture", model: "test", preset: "high" },
      sandbox: "docker",
      toolMode: "hybrid",
    });
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "New conversation preset" })).toHaveAttribute(
    "data-value",
    "high",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Choose execution options" }).click();
  await expect(page.getByRole("combobox", { name: "Sandbox", exact: true })).toHaveAttribute(
    "data-value",
    "docker",
  );
  await expect(page.getByRole("combobox", { name: "Tool interface", exact: true })).toHaveAttribute(
    "data-value",
    "hybrid",
  );
});

test("fork before a user message opens a new unsent draft and preserves the source draft", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showToolsAndActivities());
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("keep source draft");
  const user = page.locator(".cell.user").first();
  const selected = await user.locator(".user-text").textContent();
  await user.hover();
  await user.getByRole("button", { name: "Fork before this message" }).click();
  await expect(page.locator(".conversation-heading h1")).toHaveText("Forked conversation");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(selected!);
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).some(
        ([key, value]) => key.endsWith("draft:fixture") && value === "keep source draft",
      ),
    ),
  ).toBe(true);
});

test("intermediate assistant actions sit beside text; final and user actions stay below", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          localStorage.setItem("copied-message", text);
        },
      },
    });
    window.composerFixture.showToolsAndActivities();
  });
  const user = page.locator(".cell.user").first();
  const assistant = page.getByTestId("assistant-message").first();
  const fork = user.getByRole("button", { name: "Fork before this message" });
  const copy = assistant.getByRole("button", { name: "Copy message" });
  await page.getByRole("link", { name: "Settings", exact: true }).hover();
  await expect(fork).toHaveCSS("opacity", "0");
  await expect(copy).toHaveCSS("opacity", "0");
  const text = await user.locator(".user-text").boundingBox();
  const action = await fork.boundingBox();
  expect(action!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
  expect(action!.height).toBeLessThanOrEqual(20);
  await expect(fork).toHaveCSS("border-radius", "4px");
  await expect(copy).toHaveCSS("border-radius", "4px");
  await user.hover();
  await expect(fork).toHaveCSS("opacity", "1");
  await copy.focus();
  await expect(copy).toHaveCSS("opacity", "1");
  const content = await assistant.locator(".message-content").boundingBox();
  const copyBox = await copy.boundingBox();
  expect(copyBox!.x).toBeGreaterThanOrEqual(content!.x + content!.width);
  expect(copyBox!.y).toBeLessThan(content!.y + content!.height);
  expect(copyBox!.height).toBeLessThanOrEqual(20);
  await copy.click();
  await expect(assistant.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("copied-message"))).toBe(
    "Checking the stores",
  );
  await expect(assistant.getByRole("button", { name: "Copy message", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 760, height: 720 });
  const narrowText = await assistant.locator(".message-content").boundingBox();
  const narrowActions = await assistant.locator(".message-actions").boundingBox();
  expect(narrowActions!.x).toBeGreaterThanOrEqual(narrowText!.x + narrowText!.width);
  expect(narrowActions!.y).toBeLessThan(narrowText!.y + narrowText!.height);
  await page.screenshot({ path: test.info().outputPath("intermediate-message-actions.png") });
  await page.evaluate(() => window.composerFixture.completeSteps());
  await expect(assistant).not.toHaveClass(/assistant-intermediate/u);
  const finalText = await assistant.locator(".message-content").boundingBox();
  const finalActions = await assistant.locator(".message-actions").boundingBox();
  expect(finalActions!.y).toBeGreaterThanOrEqual(finalText!.y + finalText!.height);
  await page.screenshot({ path: test.info().outputPath("message-actions.png") });
  for (const phase of ["commentary", "final_answer", "future_provider_phase"]) {
    await page.evaluate((phase) => window.composerFixture.showToolsAndActivities(0, phase), phase);
    await expect(assistant).toHaveClass(/assistant-intermediate/u);
    await expect(assistant.locator(".message-phase")).toHaveCount(0);
    await expect(assistant).not.toHaveAttribute("data-phase");
    await expect(assistant.locator(".message-content")).toHaveText("Checking the stores");
    await page.evaluate(() => window.composerFixture.completeSteps());
    await expect(assistant).not.toHaveClass(/assistant-intermediate/u);
    const content = await assistant.locator(".message-content").boundingBox();
    const actions = await assistant.locator(".message-actions").boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(content!.y + content!.height);
    await page.evaluate(() =>
      window.composerFixture.appendPreviewReasoning("More work in the same turn."),
    );
    await expect(assistant).toHaveClass(/assistant-intermediate/u);
  }
});

test("message selection excludes UI labels and blank action rows", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.showToolsAndActivities();
    window.composerFixture.completeSteps();
  });
  await page.getByTestId("tool-call").first().locator(":scope > summary").click();
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  for (const [selector, word] of [
    [".user-text > span", "authentication"],
    [".message-content p", "stores"],
    ['[data-testid="tool-output"]', "file"],
  ] as const) {
    const text = page.locator(selector).first();
    await expect(text).toBeVisible();
    await text.scrollIntoViewIfNeeded();
    const point = await text.evaluate((element, word) => {
      const node = element.firstChild!;
      const start = node.textContent!.indexOf(word);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + word.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, word);
    const rect = (await text.boundingBox())!;
    const bubble =
      selector === ".user-text > span" ? (await text.locator("..").boundingBox())! : undefined;
    const column = (await page.getByTestId("transcript").boundingBox())!;
    const clip = {
      x: column.x,
      y: (bubble ?? rect).y + (bubble ?? rect).height + 1,
      width: column.width,
      height: 28,
    };
    await page.mouse.move(0, 0);
    const blankRow = await page.screenshot({ clip });
    const paddingBottom = bubble
      ? await text
          .locator("..")
          .evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom))
      : undefined;
    const padding =
      bubble && paddingBottom
        ? {
            x: rect.x,
            y: bubble.y + bubble.height - paddingBottom + 1,
            width: rect.width,
            height: paddingBottom - 1,
          }
        : undefined;
    const blankPadding = padding && (await page.screenshot({ clip: padding }));
    const side =
      selector === ".user-text > span"
        ? {
            x: rect.x + rect.width + 1,
            y: rect.y,
            width: column.x + column.width - rect.x - rect.width - 1,
            height: rect.height,
          }
        : undefined;
    const blankSide = side && (await page.screenshot({ clip: side }));
    // Select the whole paragraph to reproduce the highlight shape in the report.
    await page.mouse.click(point.x, point.y, { clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()!.toString().trim())).toBe(
      await text.innerText(),
    );
    await page.mouse.move(0, 0);
    const selectedRow = await page.screenshot({ clip });
    await page.screenshot({ path: test.info().outputPath(`${word}-paragraph-selection.png`) });
    expect(selectedRow.equals(blankRow)).toBe(true);
    if (padding && blankPadding)
      expect((await page.screenshot({ clip: padding })).equals(blankPadding)).toBe(true);
    if (side && blankSide)
      expect((await page.screenshot({ clip: side })).equals(blankSide)).toBe(true);
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
  }
  for (const selector of [".work-group-title", ".transcript-history"]) {
    const label = page.locator(selector).first();
    await label.dblclick();
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("");
  }
});

test("transcript list markers survive the Tailwind preflight reset", async ({ page }) => {
  await page.evaluate(() =>
    window.canvasFixture.appendAssistant("- bullet one\n- bullet two\n\n1. first\n2. second\n"),
  );
  const message = page.locator(".cell.assistant").last();
  await expect(message.locator("ul li").first()).toHaveText("bullet one");
  await expect(message.locator("ol li").first()).toHaveText("first");
  // Tailwind preflight sets list-style: none globally; transcript lists must restore markers.
  await expect(message.locator("ul")).toHaveCSS("list-style-type", "disc");
  await expect(message.locator("ol")).toHaveCSS("list-style-type", "decimal");
});

test("conversation header exposes inline rename on hover and preserves cancellation", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.locator(".conversation-heading h1")).toBeVisible();
  const original = await page.locator(".conversation-heading h1").textContent();
  const rename = page.getByRole("button", { name: "Rename conversation", exact: true });
  await page.mouse.move(0, 0);
  await expect(rename).toHaveCSS("opacity", "0");
  await page.locator(".conversation-heading h1").hover();
  await expect(rename).toHaveCSS("opacity", "1");
  await rename.click();
  const input = page.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Discard this");
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(rename).toBeFocused();
  await expect(page.locator(".conversation-heading h1")).toHaveText(original!);
  await rename.click();
  await input.fill("  Renamed conversation  ");
  await input.press("Enter");
  await expect(input).toBeHidden();
  await expect(page.locator(".conversation-heading h1")).toHaveText("Renamed conversation");
  await expect(
    page.locator(".sidebar").getByText("Renamed conversation", { exact: true }).first(),
  ).toBeVisible();
  await rename.click();
  await input.fill("   ");
  await expect(page.getByRole("button", { name: "Save title", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel rename", exact: true }).click();
  await expect(input).toBeHidden();
});

test("production composer retains new drafts and permits Stop during delivery acknowledgement", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const primary = page.locator(".composer-primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Stop");
  await message.fill("   ");
  await message.press("Enter");
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([]);
  await message.fill("First steering input");
  await primary.click();
  await expect(primary).toHaveText("Sending…");
  await expect(primary).toBeDisabled();
  await message.press("Enter");
  await message.press("Control+Enter");
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([
    { text: "First steering input", intent: "steer" },
  ]);
  await message.fill("Replacement draft");
  await page.evaluate(() => window.composerFixture.settle());
  await expect(primary).toHaveText("Steer");
  await expect(message).toHaveValue("Replacement draft");
  await expect(message).toBeFocused();
  await primary.click();
  await expect(primary).toHaveText("Sending…");
  await message.press("Escape");
  await expect(primary).toHaveText("Stopping…");
  await expect(primary).toBeDisabled();
  await message.press("Escape");
  expect(
    (await page.evaluate(() => window.composerFixture.calls)).map((call) => call.intent),
  ).toEqual(["steer", "steer", "interrupt"]);
  await expect(message).toHaveValue("Replacement draft");
  await message.fill("Draft after interrupt");
  await page.evaluate(() => window.composerFixture.settleStop());
  await page.evaluate(() => window.composerFixture.settle());
  await expect(primary).toHaveText("Send");
  await expect(primary).toBeEnabled();
  await expect(message).toHaveValue("Draft after interrupt");
});

test("production composer explains queued interruption and supports Escape while retaining drafts", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const primary = page.locator(".composer-primary");
  await expect(message).toBeVisible();
  await page.evaluate(() => window.composerFixture.setPendingInput());
  await expect(primary).toHaveText("Interrupt");
  await expect(primary).toHaveAttribute(
    "title",
    "Interrupt current turn; pending messages run next (Esc)",
  );
  await message.fill("Keep this draft");
  for (const event of [{ isComposing: true }, { keyCode: 229 }])
    await message.dispatchEvent("keydown", { key: "Escape", bubbles: true, ...event });
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([]);
  await message.press("Escape");
  await expect(primary).toHaveText("Interrupting…");
  await message.press("Escape");
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([
    { text: "", intent: "interrupt" },
  ]);
  await expect(message).toHaveValue("Keep this draft");
  await page.evaluate(() => window.composerFixture.settleStop());
  await expect(primary).toHaveText("Send");
  await message.press("Escape");
  expect((await page.evaluate(() => window.composerFixture.calls)).length).toBe(1);
});

test("background input and web search stay in Working and background queue details collapse", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showBackgroundWork());
  await expect(page.locator(".work-group-title")).toContainText("Working");
  await expect(page.locator(".tool-group")).toHaveCount(0);
  await expect(page.locator(".cell.user")).toHaveCount(1);
  await expect(page.locator(".cell.user")).toHaveText("Original request");
  const pending = page.locator(".pending-input");
  await expect(pending).toContainText("queue: My follow-up");
  await expect(pending.locator("summary")).toHaveText("3 background messages queued");
  await expect(pending.getByText("Background result 1", { exact: false })).not.toBeVisible();
  await pending.locator("summary").click();
  await expect(pending).toContainText("Background result 1");
  await expect(pending).toContainText("Background result 3");
  const work = page.locator(".tool-group-container");
  await expect(work.getByText("Searched the web", { exact: true })).toBeVisible();
  await work.locator("summary").filter({ hasText: "Message from subagent" }).click();
  await expect(work.getByText("Explorer found the answer", { exact: true })).toBeVisible();
});

test("production composer queues alternatively and keeps rejected drafts with disconnected guards", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const primary = page.locator(".composer-primary");
  await message.fill("Keep rejected input");
  for (const event of [{ isComposing: true }, { keyCode: 229 }])
    await message.dispatchEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      ...event,
    });
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([]);
  await message.press("Control+Enter");
  await expect(primary).toHaveText("Sending…");
  expect(await page.evaluate(() => window.composerFixture.calls)).toEqual([
    { text: "Keep rejected input", intent: "queue" },
  ]);
  await page.evaluate(() => window.composerFixture.settle(true));
  await expect(page.getByRole("alert")).toContainText("Delivery rejected");
  await expect(message).toHaveValue("Keep rejected input");
  await expect(primary).toHaveText("Steer");
  await primary.click();
  await expect(primary).toHaveText("Sending…");
  await message.fill("");
  await expect(primary).toHaveText("Stop");
  await expect(primary).toBeEnabled();
  await page.evaluate(() => window.composerFixture.settle());
  await expect(primary).toHaveText("Stop");
  await message.fill("Retained disconnected draft");
  await expect(primary).toHaveText("Steer");
  await expect(primary).toBeEnabled();
  await page.evaluate(() => window.composerFixture.disconnect());
  await expect(primary).toBeDisabled();
  await message.press("Enter");
  await message.press("Control+Enter");
  await expect(message).toHaveValue("Retained disconnected draft");
  await message.press("Escape");
  await message.fill("");
  await expect(primary).toHaveText("Stop");
  await expect(primary).toBeDisabled();
  expect((await page.evaluate(() => window.composerFixture.calls)).length).toBe(2);
});

test("settings saves shared Ask human and its approval timeout through the route action", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const reviewer = page.getByRole("combobox", { name: "Auto approver model", exact: true });
  await reviewer.click();
  await page.getByRole("option", { name: "fixture / Fixture model test", exact: true }).click();
  await expect(page.locator("input[name=reviewerModel]")).toHaveValue("fixture\u0000test");
  await reviewer.click();
  await page.getByRole("option", { name: "Use conversation model", exact: true }).click();
  await expect(page.locator("input[name=reviewerModel]")).toHaveValue("");
  await chooseDropdown(page, page.locator("[role=combobox][data-name=inWorkspace]"), "ask-human");
  await page.getByLabel("Human approval timeout (seconds)", { exact: true }).fill("12.5");
  await page.getByLabel("Auto approver timeout (seconds)", { exact: true }).fill("45.5");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({
      approval: { inWorkspace: "ask-human", humanApprovalTimeoutSeconds: 12.5 },
      autoApproval: { model: null, timeoutSeconds: 45.5 },
    });
});

test("settings saves deferred tool name visibility", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const names = page.getByRole("checkbox", { name: "Show deferred tool names" });
  await expect(names).toBeChecked();
  for (const showToolNames of [false, true]) {
    await names.setChecked(showToolNames);
    await page.getByRole("button", { name: "Save defaults", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
      .toMatchObject({ showToolNames });
    await page.getByRole("link", { name: "New conversation", exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Defaults", exact: true }).click();
    if (showToolNames) await expect(names).toBeChecked();
    else await expect(names).not.toBeChecked();
  }
});

test("settings saves and clears the global compaction threshold", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const threshold = page.getByRole("spinbutton", { name: "Compaction threshold (input tokens)" });
  await expect(threshold).toHaveValue("");
  await threshold.fill("1200");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({ compactionThresholdTokens: 1200 });
  await expect(
    page.getByText(/Restart the server to apply compaction changes/).last(),
  ).toBeVisible();
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  await expect(threshold).toHaveValue("1200");
  await threshold.fill("");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({ compactionThresholdTokens: null });
});

test("settings refreshes its model when authoritative defaults change", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  await expect(page.locator("input[name=model]")).toHaveValue("fixture\u0000test");
  await page.evaluate(() => window.composerFixture.setDefaultModel("test-latest"));
  await page.getByRole("tab", { name: "Composer", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  await expect(page.locator("input[name=model]")).toHaveValue("fixture\u0000test-latest");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({ model: { provider: "fixture", model: "test-latest" } });
});

test("adds a LiteLLM gateway from Settings and clears the API key draft", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  await page.getByText("Add LiteLLM gateway", { exact: true }).click();
  const form = page.locator(".provider-add");
  await form.getByLabel("Provider ID", { exact: true }).fill("work-gateway");
  await form.getByLabel("Label", { exact: true }).fill("Work LiteLLM");
  await form.getByLabel("Gateway URL", { exact: true }).fill("https://gateway.example.com");
  await form.getByLabel("API key", { exact: true }).fill("fixture-private");
  await form.getByRole("button", { name: "Add gateway", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("Restart");
  await expect(form.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => window.composerFixture.providerCreates)).toEqual([
    {
      id: "work-gateway",
      type: "litellm",
      label: "Work LiteLLM",
      config: { baseUrl: "https://gateway.example.com", apiKey: { stored: true } },
    },
  ]);
  await expect(page.locator("body")).not.toContainText("fixture-private");
});

for (const theme of ["light", "dark"] as const)
  test(`user message selection is distinct from its bubble in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(url + "?composer");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(() => window.composerFixture.showToolsAndActivities());
    const user = page.locator(".user-text").first();
    await expect(user).toBeVisible();
    const colors = await user.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selected = window.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
      return {
        selected: selected.toString(),
        background: getComputedStyle(element).backgroundColor,
        highlight: getComputedStyle(element, "::selection").backgroundColor,
      };
    });
    expect(colors.selected).toBe("Check authentication");
    expect(colors.highlight).not.toBe(colors.background);
  });

test("transcript selection stays in the chat column and excludes composer controls", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showMarkdown());
  const transcript = page.getByTestId("transcript");
  await expect(transcript.locator(".cell.assistant hr")).toBeVisible();
  const column = await transcript.boundingBox();
  const cell = await transcript.locator(".cell.assistant").boundingBox();
  expect(column!.width).toBe(cell!.width);
  await transcript.locator("p").first().click();
  await page.keyboard.press("ControlOrMeta+a");
  const selected = await page.evaluate(() => window.getSelection()!.toString());
  expect(selected).toContain("The wrapper resolves the alias conflict.");
  expect(selected).not.toContain("Settings");
  expect(selected).not.toContain("Fixture");
  expect(selected).not.toContain("Fixture model");
  await page.screenshot({ path: test.info().outputPath("transcript-selection.png") });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("An editable draft");
  await input.press("ControlOrMeta+a");
  expect(
    await input.evaluate((element: HTMLTextAreaElement) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
  ).toBe("An editable draft");
});

test("turn statistics occupy a footer only while enabled", async ({ page }) => {
  await page.goto(url + "?composer");
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  await expect(page.locator(".composer-footer")).toHaveCount(0);
  const bottomWithoutStats = await composer.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  await page.getByRole("button", { name: "Composer settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show last-turn statistics" }).check();
  await page.keyboard.press("Escape");
  const footer = page.locator(".composer-footer");
  await expect(footer).toBeVisible();
  expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThan(
    bottomWithoutStats,
  );
  await expect(footer.getByLabel("Last turn statistics")).toBeVisible();
  await page.getByRole("button", { name: "Composer settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show last-turn statistics" }).uncheck();
  await page.keyboard.press("Escape");
  await expect(footer).toHaveCount(0);
  await expect
    .poll(() => composer.evaluate((element) => element.getBoundingClientRect().bottom))
    .toBeCloseTo(bottomWithoutStats, 0);
});

test("provider settings expose and save native web search for supported connections", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  const work = page
    .locator(".provider")
    .filter({ has: page.getByRole("heading", { name: "Work", exact: true }) });
  await expect(page.getByLabel("Work Web search", { exact: true })).toHaveAttribute(
    "data-value",
    "true",
  );
  await expect(page.getByLabel("Personal Web search", { exact: true })).toHaveAttribute(
    "data-value",
    "false",
  );
  await expect(page.getByLabel("Gateway Web search", { exact: true })).toHaveCount(0);
  await chooseDropdown(page, page.getByLabel("Work Web search", { exact: true }), "false");
  await work.getByRole("button", { name: "Save provider settings", exact: true }).click();
  await expect(work.getByRole("status")).toContainText("Restart the server");
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.providerWrites))
    .toEqual([{ provider: "work", patch: { webSearch: false } }]);
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  await expect(page.getByLabel("Work Web search", { exact: true })).toHaveAttribute(
    "data-value",
    "false",
  );
  await chooseDropdown(page, page.getByLabel("Work Web search", { exact: true }), "true");
  await page.evaluate(() => {
    window.composerFixture.failProviderSave = true;
  });
  await work.getByRole("button", { name: "Save provider settings", exact: true }).click();
  await expect(work.getByRole("alert")).toContainText("Provider save failed");
  await page.evaluate(() => {
    window.composerFixture.failProviderSave = false;
  });
  await work.getByRole("button", { name: "Save provider settings", exact: true }).click();
  await expect(work.getByRole("status")).toContainText("Provider settings saved");
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.providerWrites.at(-1)))
    .toEqual({ provider: "work", patch: { webSearch: true } });
  await chooseDropdown(page, page.getByLabel("Work Compact output", { exact: true }), "false");
  await work.getByRole("button", { name: "Save provider settings", exact: true }).click();
  await expect(work.getByRole("status")).toContainText("Provider settings saved");
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.providerWrites.at(-1)))
    .toEqual({ provider: "work", patch: { provider: false } });
  await page.screenshot({
    path: test.info().outputPath("provider-search-settings.png"),
    fullPage: true,
  });
});

test("settings saves and clears the conversation naming model and preset", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const naming = page.getByRole("combobox", { name: "Conversation naming model", exact: true });
  await naming.click();
  await page.getByRole("option", { name: "fixture / Fixture model test", exact: true }).click();
  await chooseDropdown(page, page.locator("[role=combobox][data-name=titlePreset]"), "high");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({
      conversationTitleModel: { provider: "fixture", model: "test", preset: "high" },
    });
  await naming.click();
  await page.getByRole("option", { name: "Use conversation model", exact: true }).click();
  await expect(page.locator("[role=combobox][data-name=titlePreset]")).toBeDisabled();
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({ conversationTitleModel: null });
});

test("saved conversation titles appear in the sidebar and header", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect.poll(() => page.evaluate(() => Boolean(window.composerFixture))).toBe(true);
  await page.evaluate(() => window.composerFixture.setTitle("Fix conversation naming"));
  await expect(page.locator(".conversation-title")).toHaveText("Fix conversation naming");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix conversation naming");
});

test("tool groups are compact and activities refresh automatically only while mounted and running", async ({
  page,
}, testInfo) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => window.composerFixture.showToolsAndActivities());
  const group = page.locator(".tool-group-container");
  await expect(group.locator(".work-group-title")).toHaveText("Working for 0 s · 2 tool calls");
  await expect(group.locator(".tool-group")).toHaveCount(0);
  const call = group.locator('[data-testid="tool-call"]').first();
  await expect(call.locator(".tool-argument-preview")).toHaveCSS("white-space", "nowrap");
  const row = await call.locator("summary").boundingBox();
  expect(row!.height).toBeLessThan(30);
  await expect(call).not.toHaveAttribute("open", "");
  await call.locator("summary").click();
  await expect(call.getByTestId("tool-output")).toHaveText("Full file output");
  await expect(page.getByRole("button", { name: "Refresh output" })).toHaveCount(0);
  await expect(page.locator(".activity")).toHaveCount(1);
  await page.locator(".activities > summary").click();
  await page.locator(".activity > summary").click();
  await expect(page.locator(".activity pre")).toHaveText("Checking authentication");
  await page.screenshot({ path: testInfo.outputPath("compact-tools.png") });
  await page.evaluate(() => {
    window.composerFixture.peekOutput = "Found both stores";
    window.composerFixture.holdPeek = true;
  });
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.composerFixture.peekCalls)).toBe(2);
  await page.clock.runFor(3000);
  expect(await page.evaluate(() => window.composerFixture.peekCalls)).toBe(2);
  await page.evaluate(() => {
    window.composerFixture.holdPeek = false;
    window.composerFixture.releasePeek();
  });
  await expect(page.locator(".activity pre")).toHaveText("Found both stores");
  await page.evaluate(() => window.composerFixture.finishActivity());
  await expect(page.locator(".activities")).toHaveCount(0);
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.composerFixture.peekCalls)).toBe(2);
  await page.evaluate(() => {
    window.composerFixture.holdPeek = true;
    window.composerFixture.showToolsAndActivities();
  });
  await expect.poll(() => page.evaluate(() => window.composerFixture.peekCalls)).toBe(3);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator(".activity")).toHaveCount(0);
  await page.evaluate(() => window.composerFixture.releasePeek());
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.composerFixture.peekCalls)).toBe(3);
});

test("subagent header opens a bounded tree with retained outcomes and read-only child navigation", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Subagents", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showSubagents());
  const trigger = page.getByRole("button", { name: "Subagents · 1 running", exact: true });
  await expect(trigger).toBeVisible();
  const heading = page.locator(".conversation-header");
  expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(44);
  expect((await trigger.boundingBox())!.x).toBeGreaterThan(
    (await heading.boundingBox())!.x + (await heading.boundingBox())!.width / 2,
  );
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Subagents", exact: true });
  await expect(popup.getByRole("heading", { name: "Running", exact: true })).toBeVisible();
  await expect(
    popup
      .getByRole("region", { name: "Running", exact: true })
      .getByRole("link", { name: "Review authentication", exact: true }),
  ).toBeVisible();
  await expect(
    popup
      .getByRole("region", { name: "Finished", exact: true })
      .getByRole("link", { name: "Failed review", exact: true }),
  ).toBeVisible();
  await expect(popup.getByText("Failed", { exact: true })).toBeVisible();
  await expect(popup.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(popup.getByRole("link", { name: "Older review 16", exact: true })).toHaveCount(0);
  await popup.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(popup.getByRole("link", { name: "Older review 16", exact: true })).toBeAttached();
  await expect(popup.locator("summary")).toHaveCount(0);
  await expect(popup.getByRole("link", { name: "Check tests", exact: true })).toBeVisible();
  await popup.getByRole("link", { name: "Check tests", exact: true }).click();
  await expect(page.locator(".conversation-header h1")).toHaveText("Check tests");
  await expect(page.locator(".conversation-header .ancestor a")).toHaveText([
    "Parent conversation",
    "Review authentication",
  ]);
  await page
    .locator(".conversation-header")
    .getByRole("link", { name: "Parent conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Subagents · 1 running", exact: true }).click();
  await popup.getByRole("link", { name: "Review authentication", exact: true }).click();
  await expect(page.locator(".conversation-header h1")).toHaveText("Review authentication");
  await expect(
    page
      .locator(".conversation-header")
      .getByRole("link", { name: "Parent conversation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename conversation", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Fork before this message", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".conversation-branch")).toHaveCount(0);
  await expect(page.locator(".message-content")).toContainText("Child transcript");
  await page
    .locator(".conversation-header")
    .getByRole("link", { name: "Parent conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Subagents · 1 running", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.composerFixture.finishSubagents());
  await expect(page.getByRole("button", { name: "Subagents", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Subagents · 1 running", exact: true }),
  ).toHaveCount(0);
});

for (const width of [420, 1440]) {
  test(`empty subagent popover has no horizontal scrollbar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + "?composer");
    await page.getByRole("button", { name: "Subagents", exact: true }).click();
    const popup = page.getByRole("dialog", { name: "Subagents", exact: true });
    await expect(popup.getByText("No subagents yet.")).toBeVisible();
    expect(
      await popup.evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        nestedScrollers: [...element.querySelectorAll("*")].filter(
          (child) =>
            child.scrollWidth > child.clientWidth && getComputedStyle(child).overflowX === "auto",
        ).length,
      })),
    ).toEqual({ overflow: false, nestedScrollers: 0 });
    await expect(popup).toHaveCSS("scrollbar-width", "thin");
    expect((await page.locator(".conversation-header").boundingBox())!.height).toBeLessThanOrEqual(
      44,
    );
    await page.screenshot({ path: test.info().outputPath("subagent-popover.png") });
  });
}

test("activities expand exclusively and have a compact Stop control beside running", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showMultipleActivities());
  await page.locator(".activities > summary").click();
  const activities = page.locator(".activity");
  const first = activities.nth(0);
  const second = activities.nth(1);
  await first.locator(":scope > summary").click();
  await expect(first).toHaveAttribute("open", "");
  await second.locator(":scope > summary").click();
  await expect(second).toHaveAttribute("open", "");
  await expect(first).not.toHaveAttribute("open", "");
  const stop = first.getByRole("button", { name: "Stop activity", exact: true });
  const running = first.getByText("running", { exact: true });
  await expect
    .poll(() =>
      page
        .locator(".activities")
        .evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
    )
    .toBe(false);
  const control = await stop.boundingBox();
  const label = await running.boundingBox();
  expect(control!.width).toBeLessThanOrEqual(26);
  expect(control!.height).toBeLessThanOrEqual(30);
  expect(control!.x).toBeGreaterThanOrEqual(label!.x + label!.width);
  expect(Math.abs(control!.y + control!.height / 2 - label!.y - label!.height / 2)).toBeLessThan(2);
  await stop.click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.activityKills))
    .toEqual(["first"]);
  await expect(first).not.toHaveAttribute("open", "");
  await expect(second).toHaveAttribute("open", "");
});

test("activity refresh stops when the connection closes while the conversation stays visible", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => window.composerFixture.showToolsAndActivities());
  await expect.poll(() => page.evaluate(() => window.composerFixture.peekCalls)).toBe(1);
  await page.locator(".activities > summary").click();
  await page.locator(".activity > summary").click();
  await page.evaluate(() => window.composerFixture.disconnect());
  await expect(page.getByRole("alert")).toContainText("Disconnected fixture");
  await expect(page.getByRole("button", { name: "Stop activity", exact: true })).toBeDisabled();
  await page.clock.runFor(3000);
  expect(await page.evaluate(() => window.composerFixture.peekCalls)).toBe(1);
});

test("long tool groups mount only call previews and the details actually opened", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showLongToolRun());
  const group = page.locator(".tool-group");
  const tail = page.getByLabel("Recent work");
  await expect(group.locator(":scope > summary")).toHaveText("Worked · 100 tool calls");
  await expect(group.getByTestId("tool-call")).toHaveCount(0);
  await expect(group.locator(".diff span")).toHaveCount(0);
  await expect(tail.getByTestId("tool-call")).toHaveCount(5);
  await tail
    .getByTestId("tool-call")
    .first()
    .evaluate((row) => row.setAttribute("data-tail-row", "kept"));
  await group.locator(":scope > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(95);
  await expect(tail.getByTestId("tool-call")).toHaveCount(5);
  await expect(page.locator('[data-tail-row="kept"]')).toHaveCount(1);
  await expect(group.getByTestId("tool-output")).toHaveCount(0);
  await expect(group.locator(".diff span")).toHaveCount(0);
  const first = group.getByTestId("tool-call").first();
  await first.locator(":scope > summary").click();
  await expect(first.getByTestId("tool-output")).toHaveText("Wrote file-0.txt");
  await expect(first.locator(".diff span")).toHaveCount(1001);
  await expect(group.getByTestId("tool-output")).toHaveCount(1);
  await first.locator(":scope > summary").click();
  await expect(group.locator(".diff span")).toHaveCount(0);
  await group.locator(":scope > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(0);
  await expect(tail.getByTestId("tool-call")).toHaveCount(5);
  await expect(page.locator('[data-tail-row="kept"]')).toHaveCount(1);
});

test("reasoning and tool calls share compact inline rows between messages", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => {
    window.composerFixture.showToolsAndActivities(-60_000);
    window.composerFixture.insertReasoning();
  });
  const group = page.locator(".tool-group-container");
  await expect(group).toHaveCount(1);
  await expect(group.locator(".work-group-title")).toHaveText("Working for 0 s · 2 tool calls");
  await page.clock.runFor(2000);
  await expect(group.locator(".work-group-title")).toHaveText("Working for 2 s · 2 tool calls");
  await expect(group.locator(".tool-group")).toHaveCount(0);
  await expect(group.locator(".reasoning")).not.toHaveAttribute("open");
  await expect(group.locator(".reasoning p")).toHaveCount(0);
  await expect(group.locator(".reasoning summary")).toContainText("Checking credential ownership");
  await group.locator(".reasoning summary").click();
  await expect(group.locator(".reasoning p")).toHaveText("Checking credential ownership");
  await expect(group.getByTestId("tool-call")).toHaveCount(2);
  const label = await group.locator(".reasoning > summary").boundingBox();
  const icon = await group.locator(".tool-icon").first().boundingBox();
  expect(Math.abs(icon!.x - label!.x)).toBeLessThanOrEqual(1);
  await expect(group.locator(".reasoning")).toContainText("Checking credential ownership");
  await expect(page.getByTestId("assistant-message")).toHaveText("Checking the stores");
  await page.clock.runFor(10_000);
  await page.evaluate(() => window.composerFixture.completeSteps());
  await expect(group.locator(".reasoning summary")).toContainText("Thought for 2 s");
  await expect(group.locator(".work-group-title")).toHaveText("Worked for 12 s · 2 tool calls");
  await page.clock.runFor(2000);
  await expect(group.locator(".work-group-title")).toHaveText("Worked for 12 s · 2 tool calls");
  await page.screenshot({ path: test.info().outputPath("combined-work.png") });
});

test("earlier history loads automatically without overlap and preserves the reading anchor", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedHistory());
  await expect(
    page.locator(".user-text").filter({ hasText: /^Current history 59$/ }),
  ).toBeVisible();
  const scroller = page.locator(".conversation-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load earlier messages", exact: true }),
  ).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await expect(page.locator(".earlier-history").getByRole("status")).toContainText(
    "Loading earlier messages",
  );
  const anchor = scroller.locator(".user-text").filter({ hasText: "Current history" }).first();
  const text = (await anchor.textContent())!;
  const before = (await anchor.boundingBox())!.y;
  await scroller.evaluate((element) => {
    element.dispatchEvent(new Event("scroll"));
  });
  expect(await page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  await expect(page.locator(".earlier-history")).toHaveCount(0);
  await expect
    .poll(async () =>
      Math.abs((await page.getByText(text, { exact: true }).boundingBox())!.y - before),
    )
    .toBeLessThanOrEqual(1.5);
});

test("failed automatic history loading waits for an explicit retry", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.failHistory = true;
    window.composerFixture.seedHistory();
  });
  await expect(
    page.locator(".user-text").filter({ hasText: /^Current history 59$/ }),
  ).toBeVisible();
  const scroller = page.locator(".conversation-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  const retry = page.getByRole("button", { name: "Retry loading earlier messages" });
  await expect(retry).toBeVisible();
  expect(await page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await page.evaluate(() => {
    window.composerFixture.failHistory = false;
  });
  await retry.click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(2);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  await expect(retry).toHaveCount(0);
});

test("collapsed history loads one page per approach or upward scroll", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedCollapsedHistory());
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  await expect(page.locator(".earlier-history")).toHaveText("Earlier messages");
  // Complete rendering/observer delivery before checking that idle did not rearm.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.composerFixture.historyCalls)).toBe(1);
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  });
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(2);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  await expect(page.locator(".earlier-history")).toHaveText("Earlier messages");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.composerFixture.historyCalls)).toBe(2);
  await page.getByRole("button", { name: "Earlier messages", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.composerFixture.historyCalls)).toBe(3);
  await page.evaluate(() => window.composerFixture.releaseHistory());
  await expect(page.locator(".earlier-history")).toHaveCount(0);
});

test("eval boundaries keep child tools flat with right chevrons and failure-only labels", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showEval());
  const group = page.locator(".tool-group-container");
  await expect(group.locator(".work-group-title")).toHaveText("Worked for 12 s · 3 tool calls");
  await expect(group.locator(".tool-group")).toHaveCount(0);
  const calls = group.getByTestId("tool-call");
  await expect(calls).toHaveCount(4);
  await expect(calls.locator("summary strong")).toHaveText([
    "eval begin",
    "read_file",
    "exec",
    "eval result",
  ]);
  await expect(group.locator(".tool-failure")).toHaveText("Failed");
  await expect(group.locator(".tool-status")).toHaveCount(0);
  await expect(group.getByTestId("tool-output")).toHaveCount(0);
  const read = calls.nth(1);
  await expect
    .poll(() =>
      read.evaluate((element) => {
        const icon = element.querySelector(".tool-icon")!.getBoundingClientRect();
        const chevron = element.querySelector(".disclosure-chevron")!.getBoundingClientRect();
        const name = element.querySelector("strong")!.getBoundingClientRect();
        return element.isConnected && icon.width > 0 && icon.x < name.x && chevron.x > name.right;
      }),
    )
    .toBe(true);
  // Virtuoso measurement copies have geometry before they become interactive.
  await expect(read.locator(":scope > summary")).toBeVisible();
  await read.locator(":scope > summary").press("Enter");
  await expect(read.getByTestId("tool-output")).toHaveText("File not found");
  await expect(calls.first()).not.toHaveAttribute("open", "");
  await calls.first().locator("summary").click();
  await expect(calls.first()).toContainText("await tools.read_file");
  await expect(calls.first().getByTestId("tool-output")).toHaveCount(0);
  const result = calls.last();
  await result.locator("summary").click();
  await expect(result.getByTestId("tool-output")).toHaveText('{"updated":true}');
  await expect(result).not.toContainText("Arguments");
  await page.screenshot({ path: test.info().outputPath("eval-boundaries.png") });
});

test("the five-entry peek uses real work rows and remains after completion", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showLivePreview());
  const preview = page.getByLabel("Recent work");
  const summary = page.locator(".tool-group > summary");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("tool-call")).toHaveCount(4);
  await expect(preview.getByTestId("tool-output")).toHaveCount(0);
  await page.evaluate(() => window.composerFixture.completeSteps(false));
  await expect(summary).toContainText("Working");
  await preview.getByTestId("tool-call").last().locator(":scope > summary").click();
  await expect(preview.getByTestId("tool-output")).toHaveCount(1);
  await expect(page.locator(".tool-group")).not.toHaveAttribute("open");
  await summary.click();
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("tool-call")).toHaveCount(4);
  await preview
    .getByTestId("tool-call")
    .first()
    .evaluate((row) => row.setAttribute("data-tail-row", "kept"));
  const expanded = page.getByLabel("Work details");
  await expect(expanded.getByTestId("tool-call")).toHaveCount(1);
  await expect(page.locator('[data-tail-row="kept"]')).toHaveCount(1);
  await expect(expanded.getByTestId("tool-output")).toHaveCount(0);
  await preview.locator(".reasoning > summary").click();
  await expect(preview.locator(".reasoning p").first()).toContainText("Latest reasoning tail.");
  await summary.click();
  await expect(preview).toBeVisible();
  await expect(page.locator('[data-tail-row="kept"]')).toHaveCount(1);
  await expect(expanded).toHaveCount(0);
  await page.evaluate(() => window.composerFixture.appendPreviewReasoning(""));
  await expect(preview.getByTestId("tool-call")).toHaveCount(4);
  await page.evaluate(() =>
    window.composerFixture.appendPreviewReasoning("New reasoning after the calls. ".repeat(200)),
  );
  await expect(preview.getByTestId("tool-call")).toHaveCount(3);
  await expect(preview.locator(".preview-reasoning")).toHaveCount(2);
  await expect(preview.locator(":scope > *")).toHaveClass([
    /tool/,
    /reasoning/,
    /tool/,
    /tool/,
    /reasoning/,
  ]);
  for (const status of ["completed", "failed", "aborted"] as const) {
    if (status !== "completed") await page.evaluate(() => window.composerFixture.showLivePreview());
    await page.evaluate((status) => window.composerFixture.completeSteps(status), status);
    await expect(preview).toBeVisible();
    await expect(summary).toContainText("Worked");
  }
});

test("blank-only and blank-prefix work never offer an empty disclosure", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  for (const withTool of [false, true]) {
    await page.evaluate(
      (withTool) => window.composerFixture.showBlankReasoning(withTool),
      withTool,
    );
    const group = page.locator(".tool-group-container");
    await expect(group.locator(".work-group-title")).toBeVisible();
    await expect(group.locator(".tool-group")).toHaveCount(0);
    await expect(group.locator(".reasoning")).toHaveCount(0);
    await expect(group.getByTestId("tool-call")).toHaveCount(withTool ? 1 : 0);
  }
  await page.evaluate(() => {
    window.composerFixture.showBlankReasoning();
    window.composerFixture.splitWorkGroup();
  });
  const groups = page.locator(".tool-group-container");
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator(".tool-group")).toHaveCount(0);
  await expect(groups.first().locator(".work-group-title")).toBeVisible();
  await expect(groups.last().getByTestId("tool-call")).toHaveCount(1);
});

test("expanded work omits blank reasoning and preserves open tail rows during streaming", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.showLivePreview();
    window.composerFixture.appendPreviewReasoning("");
  });
  const group = page.locator(".tool-group-container");
  await group.locator(".tool-group > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(5);
  await expect(group.locator(".reasoning")).toHaveCount(1);
  expect(
    await group
      .locator(".work-items > .cell")
      .evaluateAll((rows) =>
        rows.map((row) => (row.classList.contains("reasoning") ? "reasoning" : "tool")),
      ),
  ).toEqual(["tool", "tool", "tool", "reasoning", "tool", "tool"]);
  await page.evaluate(() =>
    window.composerFixture.appendPreviewReasoning("A newly populated thought"),
  );
  await expect(group.locator(".reasoning")).toHaveCount(2);
  await expect(group.locator(".work-items > .cell").last()).toContainText(
    "A newly populated thought",
  );
  await group.locator(".tool-group > summary").click();
  await expect(group.getByLabel("Work details")).toHaveCount(0);
  await page.evaluate(() => window.composerFixture.showLivePreview());
  await group.locator(".tool-group > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(5);
  const tailTool = group.getByLabel("Recent work").getByTestId("tool-call").first();
  await tailTool.locator(":scope > summary").click();
  await expect(tailTool.getByTestId("tool-output")).toBeVisible();
  await tailTool.evaluate((element) => element.setAttribute("data-streaming-row", "retained"));
  await page.evaluate(() =>
    window.composerFixture.appendPreviewReasoning("A new streaming thought"),
  );
  const retained = page.locator('[data-streaming-row="retained"]');
  await expect(retained).toHaveCount(1);
  await expect(retained).toHaveAttribute("open");
  await expect(retained.getByTestId("tool-output")).toBeVisible();
});

test("long tool arguments stay within the work group width", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showToolsAndActivities());
  const group = page.locator(".tool-group-container");
  const tool = group.getByTestId("tool-call").first();
  await expect(tool.locator(".tool-argument-preview")).toBeVisible();
  const bounds = await tool.evaluate((element) => {
    const group = element.closest(".tool-group-container")!;
    return {
      rowRight: element.getBoundingClientRect().right,
      groupRight: group.getBoundingClientRect().right,
      width: group.clientWidth,
      scrollWidth: group.scrollWidth,
    };
  });
  expect(bounds.rowRight).toBeLessThanOrEqual(bounds.groupRight);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
});

test("reasoning streams into two lines before advancing a whole line", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.showBlankReasoning();
    window.composerFixture.appendPreviewReasoning("a");
  });
  const summary = page.getByLabel("Recent work").locator(".reasoning-summary");
  const excerpt = summary.locator(".reasoning-excerpt > span");
  await page.addStyleTag({
    content: ".reasoning-summary { width: 340px; flex: 0 0 340px; font-family: monospace; }",
  });
  await expect(excerpt).toHaveText("a");
  let source = "a";
  let shifts = 0;
  let secondLineGrowth = 0;
  for (const character of " b c d e f 🐈 g h i j k l m n o p q r s t u v w x y z".repeat(3)) {
    const before = await excerpt.evaluate((element) => {
      const node = element.firstChild!;
      const range = document.createRange();
      const text = node.textContent!;
      let firstTop = 0;
      let secondLine = -1;
      for (let offset = 0; offset < text.length; offset++) {
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const top = range.getBoundingClientRect().top;
        if (offset === 0) firstTop = top;
        else if (top > firstTop + 2) {
          secondLine = offset;
          break;
        }
      }
      return { text, secondLine };
    });
    source += character;
    await page.evaluate((text) => window.composerFixture.appendPreviewReasoning(text), source);
    await expect.poll(() => excerpt.textContent()).not.toBe(before.text);
    const after = (await excerpt.textContent())!;
    if (after === before.text + character) {
      if (before.secondLine >= 0) secondLineGrowth++;
    } else {
      expect(before.secondLine).toBeGreaterThan(0);
      expect(after).toBe(before.text.slice(before.secondLine) + character);
      shifts++;
    }
  }
  expect(secondLineGrowth).toBeGreaterThan(10);
  expect(shifts).toBeGreaterThanOrEqual(2);
  await summary.click();
  await expect(page.getByLabel("Recent work").locator(".reasoning p")).toHaveText(source);
  await expect(summary.locator(".preview-reasoning")).toBeHidden();
  await summary.click();
  for (const text of ["x".repeat(48), "🐈".repeat(48)]) {
    const previous = await excerpt.textContent();
    await page.evaluate((text) => window.composerFixture.appendPreviewReasoning(text), text);
    await expect.poll(() => excerpt.textContent()).not.toBe(previous);
    const rendered = (await excerpt.textContent())!;
    expect(text.endsWith(rendered)).toBe(true);
    expect(rendered).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(
      await summary.evaluate(
        (element) => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight),
      ),
    ).toBeLessThanOrEqual(2.05);
  }
});

test("compact reasoning peeks wrap under the label and keep the streamed end visible", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showLivePreview());
  const preview = page.getByLabel("Recent work");
  const reasoning = preview.locator(".preview-reasoning");
  const thought = preview.locator(".reasoning");
  const rowLayout = (marker: string) =>
    reasoning.evaluate((element, marker) => {
      const summary = element.closest(".reasoning-summary")!;
      const label = summary.querySelector(".reasoning-label")!.getBoundingClientRect();
      const text = element.querySelector(".reasoning-excerpt > span")!.firstChild;
      if (!text) return { lines: 0, markerVisible: false };
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()];
      if (lines.length === 0) return { lines: 0, markerVisible: false };
      const content = text.textContent!;
      const offset = content.lastIndexOf(marker);
      if (offset < 0) return { lines: lines.length, markerVisible: false };
      range.setStart(text, offset);
      range.setEnd(text, offset + marker.length);
      const bounds = range.getBoundingClientRect();
      const clip = summary.getBoundingClientRect();
      return {
        lines: lines.length,
        firstAfterLabel:
          lines[0]!.left >= label.right - 1 && Math.abs(lines[0]!.top - label.top) <= 2,
        secondUnderLabel: lines.length > 1 && Math.abs(lines[1]!.left - label.left) <= 2,
        markerVisible:
          bounds.left >= clip.left - 1 &&
          bounds.right <= clip.right + 1 &&
          bounds.top >= clip.top - 1 &&
          bounds.bottom <= clip.bottom + 1,
      };
    }, marker);
  const expectWrappedEnd = async (marker: string) => {
    await expect
      .poll(() => rowLayout(marker))
      .toMatchObject({
        lines: 2,
        firstAfterLabel: true,
        secondUnderLabel: true,
        markerVisible: true,
      });
    const rendered = (await reasoning.textContent())!;
    expect(rendered.length).toBeLessThan(2000);
    expect(rendered).not.toContain("\n\n");
  };
  await expect(preview).not.toContainText("old.ts");
  await expectWrappedEnd("Final check.");
  await expect(thought.locator("p")).toHaveCount(0);
  await thought.locator(":scope > summary").click();
  await expect(thought.locator("p").first()).toContainText("Latest reasoning tail.");
  await expect(thought.locator("p")).toHaveCount(3);
  await expect(reasoning).toBeHidden();
  await expect(thought.locator(".reasoning-label")).toBeVisible();
  await expect(thought.locator(":scope > summary")).toHaveText(/^Thinking for \d+ s$/, {
    useInnerText: true,
  });
  expect(
    await thought
      .locator("p")
      .nth(1)
      .evaluate((paragraph) => getComputedStyle(paragraph).marginTop),
  ).toBe("4px");
  const original = (await thought.locator("p").allTextContents()).join(" ").replace(/\s+/gu, " ");
  expect(original.length).toBeGreaterThan(2000);
  await thought.locator(":scope > summary").press("Space");
  await expect(thought.locator("p")).toHaveCount(0);
  await expectWrappedEnd("Final check.");
  expect(original.endsWith((await reasoning.textContent())!)).toBe(true);
  await page.evaluate(() => window.composerFixture.showLivePreview(true));
  await expect(page.locator(".tool-group")).toHaveCount(0);
  await page.setViewportSize({ width: 760, height: 720 });
  await expectWrappedEnd("Final check.");
  const streamed =
    "Streaming previous explanation. ".repeat(4000) + "A fresh streamed final marker.";
  await page.evaluate((text) => window.composerFixture.appendPreviewReasoning(text), streamed);
  await expectWrappedEnd("A fresh streamed final marker.");
  expect(streamed.endsWith((await reasoning.textContent())!)).toBe(true);
  await page.setViewportSize({ width: 1024, height: 720 });
  await expectWrappedEnd("A fresh streamed final marker.");
  await page.setViewportSize({ width: 760, height: 720 });
  await expectWrappedEnd("A fresh streamed final marker.");
  await thought.locator(":scope > summary").click();
  await expect(reasoning).toBeHidden();
  await page.evaluate(() =>
    window.composerFixture.appendPreviewReasoning(
      "Expanded stream content. ".repeat(4000) + "Updated while expanded.",
    ),
  );
  await expect(thought.locator("p")).toHaveText(/Updated while expanded\.$/);
  await expect(reasoning).toBeHidden();
  await thought.locator(":scope > summary").press("Space");
  await expect(thought.locator("p")).toHaveCount(0);
  await expectWrappedEnd("Updated while expanded.");
  await page.evaluate(() => window.composerFixture.showLivePreview(true));
  const summary = thought.locator(".reasoning-summary");
  for (const width of [200.6, 214.6]) {
    await summary.evaluate((element, width) => {
      Object.assign(element.style, {
        flex: `0 0 ${width}px`,
        width: `${width}px`,
        maxWidth: `${width}px`,
      });
    }, width);
    expect(
      await summary.evaluate((element) => parseFloat(getComputedStyle(element).width)),
    ).toBeCloseTo(width, 1);
    await expectWrappedEnd("Final check.");
    await expect
      .poll(() =>
        summary.evaluate(
          (element) =>
            element.getBoundingClientRect().height -
            2 * parseFloat(getComputedStyle(element).lineHeight),
        ),
      )
      .toBeLessThanOrEqual(0.5);
  }
  await summary.evaluate((element) => {
    for (const property of ["flex", "width", "max-width"]) element.style.removeProperty(property);
  });
  await expectWrappedEnd("Final check.");
  await page.screenshot({ path: test.info().outputPath("quiet-live-preview.png") });
});

for (const kind of ["tool", "thought"] as const) {
  test(`open ${kind} headers stay reachable while scrolling Work`, async ({ page }) => {
    await page.goto(url + "?composer");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate((kind) => {
      if (kind === "tool") window.composerFixture.showWorkGroups();
      else window.composerFixture.showLivePreview(true);
    }, kind);
    const group = page.locator(".tool-group-container").last();
    if (kind === "tool") {
      await group.locator(".tool-group > summary").click();
      await expect(group.getByTestId("tool-call")).toHaveCount(6);
    }
    const item = group
      .locator(kind === "tool" ? '[data-testid="tool-call"]' : ".reasoning")
      .first();
    const header = item.locator(":scope > summary");
    await header.click();
    await expect(item).toHaveAttribute("open");
    await expect
      .poll(() =>
        group.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
      )
      .toBe(false);
    await group.evaluate((element) => {
      element.scrollTop = 300;
    });
    await expect
      .poll(async () => {
        const top = (await group.boundingBox())!.y;
        return Math.abs((await header.boundingBox())!.y - top);
      })
      .toBeLessThanOrEqual(1);
    await header.click();
    await expect(item).not.toHaveAttribute("open");
  });
}

test("expanding work keeps row width stable when native scrollbars appear", async ({
  playwright,
}) => {
  const browser = await playwright.chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url + "?composer");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(() => window.composerFixture.showLongToolRun());
    await expect(page.getByLabel("Recent work").getByTestId("tool-call")).toHaveCount(5);
    const samples = await page.evaluate(
      () =>
        new Promise<Array<{ left: number; width: number }>>((resolve) => {
          const group = document.querySelector<HTMLElement>(".tool-group-container")!;
          const disclosure = group.querySelector<HTMLElement>(".tool-group")!;
          const tail = group.querySelector('[aria-label="Recent work"] [data-testid="tool-call"]')!;
          const measure = () => {
            const rect = tail.getBoundingClientRect();
            return { left: rect.left, width: rect.width };
          };
          const samples = [measure()];
          const onStart = (event: Event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || target.parentElement !== disclosure) return;
            disclosure.removeEventListener("animationstart", onStart);
            const animation = target.getAnimations()[0]!;
            animation.pause();
            for (const time of [0, 30, 75, 150]) {
              animation.currentTime = time;
              samples.push(measure());
            }
            animation.finish();
            resolve(samples);
          };
          disclosure.addEventListener("animationstart", onStart);
          disclosure.querySelector<HTMLElement>("summary")!.click();
        }),
    );
    for (const sample of samples) {
      expect(Math.abs(sample.left - samples[0]!.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.width - samples[0]!.width)).toBeLessThanOrEqual(1);
    }
    const scroll = await page.locator(".tool-group-container").evaluate((element: HTMLElement) => ({
      overflowing: element.scrollHeight > element.clientHeight,
      scrollbar: element.offsetWidth - element.clientWidth,
    }));
    expect(scroll.overflowing).toBe(true);
    expect(scroll.scrollbar).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test("sticky tool summaries cover output at fractional display scale", async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 1.25 });
  try {
    const page = await context.newPage();
    await page.goto(url + "?composer");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(() => window.composerFixture.showWorkGroups());
    const group = page.locator(".tool-group-container").last();
    await group.locator(".tool-group > summary").click();
    await expect(group.getByTestId("tool-call")).toHaveCount(6);
    const tool = group.getByLabel("Recent work").getByTestId("tool-call").first();
    await tool.locator(":scope > summary").click();
    const output = tool.getByTestId("tool-output");
    await expect(output).toBeVisible();
    await expect
      .poll(() =>
        group.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
      )
      .toBe(false);
    await group.evaluate((element) => {
      element.scrollTop = 302;
    });
    await expect(group).toHaveAttribute("data-scroll-above");
    const rect = (await group.boundingBox())!;
    const clip = { x: rect.x + 40, y: Math.floor(rect.y), width: 500, height: 3 };
    const withOutput = await page.screenshot({ clip });
    await output.evaluate((element) => {
      element.style.visibility = "hidden";
    });
    const withoutOutput = await page.screenshot({ clip });
    expect(withOutput.equals(withoutOutput)).toBe(true);
  } finally {
    await context.close();
  }
});

test("only the latest Work group peeks; every earlier group folds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups());
  const groups = page.locator(".tool-group-container");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator(".tool-group")).not.toHaveAttribute("open");
  await expect(groups.nth(0).getByTestId("tool-call")).toHaveCount(0);
  await expect(groups.nth(0).getByLabel("Recent work")).toHaveCount(0);
  // Every earlier group folds regardless of size; only the latest peeks.
  await expect(groups.nth(1).locator(".tool-group")).toHaveCount(1);
  await expect(groups.nth(1).getByTestId("tool-call")).toHaveCount(0);
  await expect(groups.nth(1).getByLabel("Recent work")).toHaveCount(0);
  await expect(groups.nth(2).getByLabel("Recent work").getByTestId("tool-call")).toHaveCount(5);
  const latest = groups.nth(2).locator(".tool-group");
  await latest.locator(":scope > summary").click();
  await expect(latest.getByTestId("tool-call")).toHaveCount(1);
  await expect(groups.nth(2).getByLabel("Recent work").getByTestId("tool-call")).toHaveCount(5);
  await expect(groups.nth(2).getByTestId("tool-call")).toHaveCount(6);
  const first = groups.nth(2).getByTestId("tool-call").nth(0);
  const second = groups.nth(2).getByTestId("tool-call").nth(1);
  await first.locator(":scope > summary").click();
  await expect(first.getByTestId("tool-output")).toBeVisible();
  await second.locator(":scope > summary").click();
  await expect(first).not.toHaveAttribute("open");
  await expect(first.getByTestId("tool-output")).toHaveCount(0);
  await expect(second.getByTestId("tool-output")).toBeVisible();
  await expect
    .poll(() =>
      groups
        .nth(2)
        .evaluate((group) =>
          group
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
    )
    .toBe(false);
  const scrolling = await groups.nth(2).evaluate((group) => {
    const output = group.querySelector('[data-testid="tool-output"]')!;
    return {
      height: group.getBoundingClientRect().height,
      viewport: innerHeight,
      scrolls: group.scrollHeight > group.clientHeight,
      innerOverflow: getComputedStyle(output).overflowY,
      innerMax: getComputedStyle(output).maxHeight,
    };
  });
  expect(scrolling.height).toBeLessThanOrEqual(scrolling.viewport * 0.4);
  expect(scrolling.height).toBeGreaterThanOrEqual(scrolling.viewport * 0.4 - 1);
  expect(scrolling.scrolls).toBe(true);
  expect(scrolling.innerOverflow).toBe("visible");
  expect(scrolling.innerMax).toBe("none");
  await groups.nth(2).evaluate((group) => {
    group.scrollTop = 0;
  });
  await expect(groups.nth(2)).not.toHaveAttribute("data-scroll-above");
  await expect(groups.nth(2)).toHaveAttribute("data-scroll-below");
  await groups.nth(2).evaluate((group) => {
    group.scrollTop = 300;
  });
  await expect(groups.nth(2)).toHaveAttribute("data-scroll-above");
  await expect(groups.nth(2)).toHaveAttribute("data-scroll-below");
  const clip = await groups.nth(2).evaluate((group) => {
    const rect = group.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + 1;
    if (!document.elementFromPoint(x, y)?.closest('[data-testid="tool-output"], summary'))
      throw new Error("Shadow probe must cover opaque work content");
    return { x, y, width: 40, height: 8 };
  });
  const shadow = await page.screenshot({ clip });
  const hideShadow = await page.addStyleTag({
    content: ".work-scroll-frame::after { display: none; }",
  });
  const withoutShadow = await page.screenshot({ clip });
  expect(shadow.equals(withoutShadow)).toBe(false);
  await hideShadow.evaluate((style) => style.parentNode!.removeChild(style));
  await groups.nth(2).evaluate((group) => {
    group.scrollTop = group.scrollHeight;
  });
  await expect(groups.nth(2)).toHaveAttribute("data-scroll-above");
  await expect(groups.nth(2)).not.toHaveAttribute("data-scroll-below");
  await groups.nth(0).locator(".tool-group > summary").click();
  await expect(latest).not.toHaveAttribute("open");
  await expect(page.locator(".tool-group[open]")).toHaveCount(1);
  await expect(groups.nth(0).getByTestId("tool-call")).toHaveCount(4);
  await expect(groups.nth(2).getByLabel("Recent work")).toBeVisible();
  await expect(second.getByTestId("tool-output")).toBeVisible();
  await expect(groups.nth(2)).toHaveAttribute("data-scroll-above");
  await expect(groups.nth(2)).not.toHaveAttribute("data-scroll-below");
});

test("reasoning rows render identically in the tail and in expanded details", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.showLivePreview();
    window.composerFixture.insertReasoning();
  });
  await page.locator(".tool-group > summary").click();
  for (const summary of [
    page.getByLabel("Work details").locator(".reasoning > summary"),
    page.getByLabel("Recent work").locator(".reasoning > summary"),
  ]) {
    await expect(summary).toContainText(/Thinking|Thought/);
    await expect(summary.locator(".preview-reasoning")).toHaveCount(1);
    await expect(summary.locator(".preview-reasoning")).not.toBeEmpty();
    await expect(summary.locator(".preview-reasoning")).toBeVisible();
    const inline = await summary.evaluate((element) => {
      const label = element.querySelector(".reasoning-label")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element.querySelector(".reasoning-excerpt > span")!);
      const preview = range.getClientRects()[0]!;
      return {
        labelTop: label.top,
        previewTop: preview.top,
        labelRight: label.right,
        previewLeft: preview.left,
      };
    });
    expect(Math.abs(inline.labelTop - inline.previewTop)).toBeLessThanOrEqual(2);
    expect(inline.previewLeft).toBeGreaterThanOrEqual(inline.labelRight);
    await summary.click();
    await expect(summary.locator(".preview-reasoning")).toBeHidden();
    await expect(summary.locator(".reasoning-label")).toBeVisible();
    await expect(summary.locator("..").locator(".collapse-body p").first()).toBeVisible();
  }
});

test("virtualizing latest work never replays its opening animation", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.tailOpeningAnimations = "0";
    document.addEventListener("animationstart", (event) => {
      if (
        event.animationName === "collapse-open" &&
        event.target instanceof HTMLElement &&
        event.target.classList.contains("work-tail")
      ) {
        document.documentElement.dataset.tailOpeningAnimations = String(
          Number(document.documentElement.dataset.tailOpeningAnimations) + 1,
        );
      }
    });
    window.composerFixture.showLivePreview(true, true);
  });
  const tail = page.locator(".work-tail");
  await expect(tail).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  await expect(tail).toHaveCSS("animation-name", "none");
  await tail.evaluate((element) => element.setAttribute("data-initial-tail", "true"));
  const scroll = page.locator(".conversation-scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByLabel("Recent work")).toHaveCount(0);
  await expect(
    page.locator(".cell.user").getByText("Earlier preview history 0", { exact: true }),
  ).toBeVisible();
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(tail).toBeVisible();
  await expect(page.locator('[data-initial-tail="true"]')).toHaveCount(0);
  await expect(tail).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.documentElement.dataset.tailOpeningAnimations)).toBe(
    "0",
  );
});

test("superseding expanded latest work preserves its tail without a new enter animation", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups());
  const groups = page.locator(".tool-group-container");
  await groups.nth(2).locator(".tool-group > summary").click();
  await expect(groups.nth(2).getByTestId("tool-call")).toHaveCount(6);
  await groups
    .nth(2)
    .locator(".work-tail")
    .evaluate((element) => {
      element.setAttribute("data-retained-tail", "true");
      element.addEventListener("animationstart", (event) => {
        if (
          event instanceof AnimationEvent &&
          event.target === element &&
          event.animationName === "collapse-open"
        ) {
          element.setAttribute("data-replayed-enter", "true");
        }
      });
    });
  await page.evaluate(() => window.composerFixture.splitWorkGroup());
  await expect(groups).toHaveCount(4);
  const retained = page.locator('[data-retained-tail="true"]');
  await expect(retained).toBeVisible();
  await expect(retained).toHaveAttribute("data-state", "open");
  await expect(retained).toHaveCSS("animation-name", "none");
  await expect(retained).not.toHaveAttribute("data-replayed-enter");
  await expect(groups.nth(2).getByTestId("tool-call")).toHaveCount(6);
  const historical = retained.locator("..");
  for (const tool of [
    historical.getByLabel("Work details").getByTestId("tool-call").first(),
    retained.getByTestId("tool-call").first(),
  ]) {
    await tool.locator(":scope > summary").click();
    await expect(tool.getByTestId("tool-output")).toBeVisible();
    await expect
      .poll(() =>
        historical.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
      )
      .toBe(false);
    await expect(retained).toHaveCount(1);
    await expect(retained).toBeVisible();
    await expect(retained).not.toHaveAttribute("data-lazy");
    await expect(retained).toHaveCSS("animation-name", "none");
    await expect(retained).not.toHaveAttribute("data-replayed-enter");
    await expect(historical.locator(".tool-group")).toHaveAttribute("open");
  }
});

test("superseding the latest Work group folds its tail", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups());
  const groups = page.locator(".tool-group-container");
  await expect(groups.nth(2).getByLabel("Recent work").getByTestId("tool-call")).toHaveCount(5);
  const closingAnimation = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const tail = document
          .querySelectorAll(".tool-group-container")[2]!
          .querySelector(".work-tail")!;
        const onStart = (event: Event) => {
          const animation = event as AnimationEvent;
          if (event.target === tail && animation.animationName === "collapse-close") {
            tail.removeEventListener("animationstart", onStart);
            resolve(animation.animationName);
          }
        };
        tail.addEventListener("animationstart", onStart);
        window.composerFixture.splitWorkGroup();
      }),
  );
  expect(closingAnimation).toBe("collapse-close");
  await expect(groups).toHaveCount(4);
  await expect(groups.nth(2).getByLabel("Recent work")).toHaveCount(0);
  await expect(groups.nth(2).locator(".tool-group > summary")).toContainText("Worked");
  await expect(groups.nth(3).getByLabel("Recent work").getByTestId("tool-call")).toHaveCount(1);
  await groups.nth(2).locator(".tool-group > summary").click();
  await expect(groups.nth(2).getByTestId("tool-call")).toHaveCount(6);
});

test("reduced motion folds superseded work without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups());
  const groups = page.locator(".tool-group-container");
  await expect(groups.nth(2).getByLabel("Recent work")).toBeVisible();
  await page.evaluate(() => window.composerFixture.splitWorkGroup());
  await expect(groups).toHaveCount(4);
  await expect(groups.nth(2).getByLabel("Recent work")).toHaveCount(0);
  await groups.nth(2).locator(".tool-group > summary").click();
  await expect(groups.nth(2).getByTestId("tool-call")).toHaveCount(6);
  expect(
    await groups.nth(2).evaluate((element) => element.getAnimations({ subtree: true }).length),
  ).toBe(0);
});

test("expanding an earlier Work group preserves the topmost visible row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups(30));
  await expect(
    page.locator(".cell.user").getByText("Following message 29", { exact: true }),
  ).toBeVisible();
  const scroll = page.locator(".conversation-scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const group = page
    .locator(".tool-group-container")
    .filter({ has: page.locator(".tool-group > summary", { hasText: "3 tool calls" }) });
  await expect(group.locator(".tool-group > summary")).toBeVisible();
  await group.evaluate((element) => {
    const scroll = element.closest(".conversation-scroll")!;
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 2;
  });
  await expect
    .poll(() =>
      group.evaluate((element) => {
        const scroll = element.closest(".conversation-scroll")!;
        return Math.abs(
          element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 2,
        );
      }),
    )
    .toBeLessThanOrEqual(2);
  expect(await gap(page)).toBeGreaterThan(100);
  const before = (await group.boundingBox())!.y;
  await group.locator(".tool-group > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(3);
  await expect
    .poll(() =>
      group.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  expect(Math.abs((await group.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
});

test("actionable transcript rows highlight on hover and keyboard focus", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showWorkGroups());
  for (const row of [
    page.locator(".tool-group > summary").first(),
    page.getByLabel("Recent work").locator("summary").first(),
  ]) {
    await expect(row).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(row).toHaveCSS("cursor", "pointer");
    const plain = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    await row.hover();
    await expect
      .poll(() => row.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(plain);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await row.focus();
    await expect(row).toBeFocused();
    await expect
      .poll(() => row.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(plain);
    await row.evaluate((element) => (element as HTMLElement).blur());
  }
});

test("sidebar scroll shadows follow the edges and clear when sections collapse", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const sidebar = page.getByRole("navigation", { name: "Conversations" });
  await expect(sidebar).not.toHaveAttribute("data-scroll-above");
  await expect(sidebar).toHaveAttribute("data-scroll-below");
  await sidebar.evaluate((element) => {
    element.scrollTop = 30;
  });
  await expect(sidebar).toHaveAttribute("data-scroll-above");
  await expect(sidebar).toHaveAttribute("data-scroll-below");
  expect(await sidebar.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
    "radial-gradient",
  );
  await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(sidebar).toHaveAttribute("data-scroll-above");
  await expect(sidebar).not.toHaveAttribute("data-scroll-below");
  await page.locator(".sidebar-recents > summary").click();
  await page.locator(".sidebar-projects > summary").click();
  await expect(sidebar).not.toHaveAttribute("data-scroll-above");
  await expect(sidebar).not.toHaveAttribute("data-scroll-below");
});

test("sidebar grid collapse animates height and opacity, then unmounts", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const recents = page.locator(".sidebar-project").first();
  const content = recents.locator(":scope > .collapse-grid");
  await content.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  const fullHeight = (await content.boundingBox())!.height;
  await recents.locator(":scope > summary").click();
  const halfway = await content.evaluate((element) => {
    const animation = element.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 75;
    return {
      height: element.getBoundingClientRect().height,
      opacity: parseFloat(getComputedStyle(element).opacity),
    };
  });
  expect(halfway.height).toBeGreaterThan(0);
  expect(halfway.height).toBeLessThan(fullHeight);
  expect(halfway.opacity).toBeGreaterThan(0);
  expect(halfway.opacity).toBeLessThan(1);
  await content.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  await expect(content).toHaveCount(0);
  await recents.locator(":scope > summary").press("Enter");
  await expect(content).toBeVisible();
  await content.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  await expect(recents.getByRole("link")).toHaveCount(5);
});

test("reduced motion collapses sidebar content without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const recents = page.locator(".sidebar-project").first();
  const content = recents.locator(":scope > .collapse-grid");
  expect(await content.evaluate((element) => element.getAnimations().length)).toBe(0);
  await recents.locator(":scope > summary").click();
  await expect(content).toHaveCount(0);
  await recents.locator(":scope > summary").press("Space");
  await expect(recents.getByRole("link")).toHaveCount(5);
});

test("sidebar groups all folders, pages five chats, and keeps hidden projects in Recents", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const recents = page.locator(".sidebar-recents");
  const project = page.locator('.sidebar-project:has(> summary[title="/work/a/repo"])');
  await expect(recents.getByRole("link")).toHaveCount(20);
  await expect(page.locator(".sidebar-project")).toHaveCount(3);
  await expect(project.getByRole("link")).toHaveCount(5);
  await page.screenshot({ path: test.info().outputPath("sidebar-folders.png") });
  await project.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(project.getByRole("link")).toHaveCount(10);
  await project.locator(":scope > summary").click();
  await expect(project).not.toHaveAttribute("open");
  await project.locator(":scope > summary").hover();
  await project.getByRole("button", { name: "Hide project /work/a/repo", exact: true }).click();
  await expect(project).toHaveCount(0);
  await expect(recents.getByRole("link", { name: "Chat 0-0", exact: true })).toBeVisible();
  await recents.getByRole("link", { name: "Chat 0-0", exact: true }).click();
  await expect(project).toHaveCount(1);
  await expect(project).not.toHaveAttribute("open");
  await recents.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(recents.getByRole("link")).toHaveCount(40);
});

test("sidebar resize and visibility persist, while project preferences stay host scoped", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const separator = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(separator).toHaveAttribute("aria-valuenow", "220");
  await separator.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "400");
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "160");
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(310, box.y + 50);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "310");
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  const project = page.locator('.sidebar-project:has(> summary[title="/work/b/repo"])');
  await project.locator(":scope > summary").hover();
  await project.getByRole("button", { name: "Hide project /work/b/repo", exact: true }).click();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Show sidebar", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  await expect(project).toHaveCount(0);
  await page.evaluate(() => window.composerFixture.switchSidebarScope("another-host"));
  await expect(project).toHaveCount(1);
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  await page.evaluate(() => window.composerFixture.switchSidebarScope("composer-fixture"));
  await expect(project).toHaveCount(0);
});

test("creating a chat restores its hidden folder without clearing collapse preferences", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  const project = page.locator('.sidebar-project:has(> summary[title="/work/b/repo"])');
  await project.locator(":scope > summary").click();
  await project.locator(":scope > summary").hover();
  await project.getByRole("button", { name: "Hide project /work/b/repo", exact: true }).click();
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("textbox", { name: "Project folder" }).fill("/work/b/repo");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New chat", exact: true })).toBeVisible();
  await expect(project).toHaveCount(1);
  await expect(project).not.toHaveAttribute("open");
});

test("quiet sidebar keeps long project rows aligned and fully inside the resized navigation", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar(true));
  const recent = page.locator(".sidebar-recents");
  const project = page.locator('.sidebar-project:has(> summary[title="/work/a/repo"])');
  await expect(project.getByRole("link")).toHaveCount(5);
  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  await page.keyboard.press("Home");
  const bounds = await page.locator(".conversation-list").evaluate((nav) => {
    const project = nav.querySelector(".project-conversations > a")!;
    const rect = nav.getBoundingClientRect();
    const p = project.getBoundingClientRect();
    const more = nav.querySelector(".sidebar-more")!;
    return {
      projectTextLeft: project.querySelector(".conversation-title")!.getBoundingClientRect().left,
      projectLabelLeft: nav.querySelector(".project-label")!.getBoundingClientRect().left,
      projectRight: p.right,
      contentRight: rect.left + nav.clientLeft + nav.clientWidth,
      sidebarRight: nav.closest(".sidebar")!.getBoundingClientRect().right,
      scrollbarRight: rect.right,
      scrollbarTop: rect.top,
      overflow: nav.scrollWidth > nav.clientWidth,
      moreHeight: more.getBoundingClientRect().height,
      moreShadow: getComputedStyle(more).boxShadow,
    };
  });
  expect(bounds.projectTextLeft).toBe(bounds.projectLabelLeft);
  expect(bounds.contentRight - bounds.projectRight).toBeGreaterThanOrEqual(20);
  expect(bounds.sidebarRight - bounds.scrollbarRight).toBe(2);
  expect(bounds.overflow).toBe(false);
  expect(bounds.moreHeight).toBeLessThanOrEqual(26);
  expect(bounds.moreShadow).toBe("none");
  await project.getByRole("link").first().click();
  await expect(project.locator("a.active")).toHaveCount(1);
  await recent.locator(":scope > summary").click();
  await expect(recent).not.toHaveAttribute("open");
  await project.locator("a.active").scrollIntoViewIfNeeded();
  await page.mouse.move(bounds.scrollbarRight - 4, bounds.scrollbarTop + 40);
  expect(
    await page.locator(".conversation-list").evaluate((nav) => {
      const row = nav.querySelector(".project-conversations > a")!;
      return (
        nav.getBoundingClientRect().left +
        nav.clientLeft +
        nav.clientWidth -
        row.getBoundingClientRect().right
      );
    }),
  ).toBeGreaterThanOrEqual(20);
  await page.screenshot({ path: test.info().outputPath("quiet-sidebar-light.png") });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({ path: test.info().outputPath("quiet-sidebar-dark.png") });
});

test("conversation has a compact title, readable prose and a quiet Markdown separator", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.setTitle("Building a Teaching Assistant");
    window.composerFixture.showMarkdown();
  });
  await expect(page.locator(".cell.assistant hr")).toHaveCount(1);
  await expect(page.locator(".conversation-header h1")).toHaveText("Building a Teaching Assistant");
  await expect(page.locator(".workspace-path")).toHaveCount(0);
  await expect(async () => {
    const metrics = await page.locator("body").evaluate((body) => {
      // Read one live DOM snapshot while the virtualizer can replace cell elements.
      const cell = body.querySelector(".cell.assistant")!;
      const rule = getComputedStyle(cell.querySelector("hr")!);
      return {
        connected: cell.isConnected,
        text: getComputedStyle(cell).fontSize,
        heading: getComputedStyle(cell.querySelector("h1")!).fontSize,
        ruleWidth: rule.borderTopWidth,
        ruleMargin: parseFloat(rule.marginTop),
        headerHeight: document.querySelector(".conversation-header")!.getBoundingClientRect()
          .height,
      };
    });
    expect(metrics.connected).toBe(true);
    expect(metrics.text).toBe("14px");
    expect(parseFloat(metrics.heading)).toBeCloseTo(18.2, 1);
    expect(metrics.ruleWidth).toBe("1px");
    expect(metrics.ruleMargin).toBeLessThanOrEqual(16);
    expect(metrics.headerHeight).toBeLessThanOrEqual(44);
  }).toPass({ timeout: 5000 });
  await expect(page.locator(".composer-footer")).toHaveCount(0);
  await expect(page.locator(".composer-wrap")).not.toContainText("Enter send");
  await expect(page.locator(".cell.assistant hr")).toBeVisible();
  await expect(page.locator(".cell.assistant hr")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("quiet-conversation-light.png") });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({ path: test.info().outputPath("quiet-conversation-dark.png") });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const size = page.getByRole("combobox", { name: "Conversation text size" });
  await expect(size).toHaveAttribute("data-value", "14");
  await chooseDropdown(page, size, "16");
  await page
    .locator(".sidebar-recents")
    .getByRole("link", { name: "Building a Teaching Assistant", exact: true })
    .click();
  await expect(page.locator(".cell.assistant")).toHaveCSS("font-size", "16px");
  await page.reload();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Conversation text size" })).toHaveAttribute(
    "data-value",
    "16",
  );
});

for (const fontSize of [12, 13, 14, 15, 16, 17, 18]) {
  test(`fractional measurement preserves initial bottom and stream follow at ${fontSize}px`, async ({
    page,
  }) => {
    await page.addInitScript((size) => {
      new MutationObserver((_, observer) => {
        if (document.documentElement) {
          document.documentElement.style.setProperty("--conversation-font-size", `${size}px`);
          observer.disconnect();
        }
      }).observe(document, { childList: true });
    }, fontSize);
    await page.reload();
    await expect(page.locator(".cell.assistant")).toBeVisible();
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
    await page.evaluate(() => window.canvasFixture.grow());
    await expect(page.locator(".cell.assistant")).toContainText("Additional streaming paragraph");
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  });
}

test("running chats use a quiet spinner and unread output clears on opening", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await expect(
    page.locator(".conversation-list").getByRole("img", { name: "Running" }),
  ).toHaveCount(1);
  await page.evaluate(() => window.composerFixture.seedSidebar());
  await page.evaluate(() => window.composerFixture.markUnread("sidebar-0-0"));
  await expect(page.getByLabel("Unread", { exact: true })).toHaveCount(2);
  await page
    .locator(".sidebar-recents")
    .getByRole("link", { name: /^Chat 0-0/u })
    .click();
  await expect(page.getByLabel("Unread", { exact: true })).toHaveCount(0);
});

test("sidebar headings and chat titles do not select text on double click", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedSidebar());
  for (const selector of [
    ".sidebar-projects > summary",
    ".sidebar-recents > summary",
    ".sidebar-project > summary",
  ]) {
    await page.locator(selector).first().dblclick();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
    const section = page.locator(selector).first().locator("..");
    if ((await section.getAttribute("open")) === null) await page.locator(selector).first().click();
  }
  await page.locator('.sidebar-recents a[href$="/sidebar-0-0"]').dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
});

test("worktree selection stays subtle, refuses running switches and switches back without moving history", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeDisabled();
  await expect(page.getByText("Stop the conversation before switching.")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("worktree-selection.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.composerFixture.completeSteps("completed"));
  await page.getByRole("button", { name: "main", exact: true }).click();
  await page.getByRole("button", { name: "New worktree", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.worktreeSwitches))
    .toEqual([{ kind: "new" }]);
  await expect(page.locator(".conversation-branch")).toContainText("harness/one");
  await page.getByRole("button", { name: "Original checkout", exact: true }).click();
  await expect(page.locator(".conversation-branch")).toContainText("main");
  await expect(page.locator(".composer")).toBeVisible();
});
test("opening the worktree picker reads an externally renamed branch", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.completeSteps("completed"));
  await page.getByRole("button", { name: "main", exact: true }).click();
  await page.getByRole("button", { name: "New worktree", exact: true }).click();
  await expect(page.locator(".conversation-branch")).toHaveText("harness/one");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.composerFixture.renameWorktree("feature/renamed"));
  await page.getByRole("button", { name: "harness/one", exact: true }).click();
  await expect(page.locator(".conversation-branch")).toHaveText("feature/renamed");
  await expect(page.locator(".worktree-current strong")).toHaveText("feature/renamed");
  await expect(
    page.locator(".worktree-options").getByRole("button", { name: "harness/one", exact: true }),
  ).toHaveCount(0);
});

test("worktree picker pins the current checkout, limits recent entries and retains older selection", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.completeSteps("completed");
    window.composerFixture.seedRecentWorktrees();
  });
  await page.locator(".conversation-branch").click();
  await expect(page.locator(".worktree-current strong")).toHaveText("harness/recent-6");
  await expect(page.locator(".worktree-recent button[title]")).toHaveText([
    "harness/recent-0",
    "harness/recent-1",
    "harness/recent-2",
    "harness/recent-3",
  ]);
  await expect(page.locator(".worktree-actions").getByRole("button")).toHaveText([
    "Original checkout",
    "New worktree",
  ]);
  const currentStyle = await page.locator(".worktree-current").evaluate((element) => ({
    color: getComputedStyle(element).color,
    opacity: getComputedStyle(element).opacity,
  }));
  expect(currentStyle.opacity).toBe("1");
  expect(currentStyle.color).toBe(
    await page.locator(".worktree-options").evaluate((element) => getComputedStyle(element).color),
  );
  await page.getByRole("button", { name: "Show all worktrees", exact: true }).click();
  await expect(page.locator(".worktree-recent button[title]")).toHaveCount(7);
  await page.getByRole("button", { name: "harness/recent-7", exact: true }).click();
  await expect(page.locator(".worktree-current strong")).toHaveText("harness/recent-7");
  await page.keyboard.press("Escape");
  await page.locator(".conversation-branch").click();
  await expect(page.locator(".worktree-recent button[title]")).toHaveCount(4);
  await page.getByRole("button", { name: "Original checkout", exact: true }).click();
  await expect(page.locator(".worktree-current strong")).toHaveText("main");
  await expect(page.locator(".worktree-recent button[title]")).toHaveCount(5);
  await page.screenshot({ path: test.info().outputPath("worktree-picker.png") });
});

test("worktree conversations share their original sidebar project and navigation reveals that group", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.seedWorktreeSidebar());
  const project = page.locator('.sidebar-project:has(> summary[title="/work/a/repo"])');
  await expect(page.locator(".sidebar-project")).toHaveCount(3);
  await expect(project.getByRole("link")).toHaveCount(5);
  await expect(project.getByLabel("Worktree", { exact: true })).toHaveCount(5);
  await project.locator(":scope > summary").hover();
  await project.getByRole("button", { name: "Hide project /work/a/repo", exact: true }).click();
  await expect(project).toHaveCount(0);
  await page.locator(".sidebar-recents").getByText("Chat 0-0", { exact: true }).click();
  await expect(project).toHaveCount(1);
  await expect(project.getByRole("link")).toHaveCount(5);
});

test("worktree manager requires explicit destructive confirmation", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Worktrees", exact: true }).click();
  await expect(page.getByText("D:\\worktrees\\one", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(await page.evaluate(() => window.composerFixture.worktreeDeletes)).toEqual([]);
  await page.getByRole("button", { name: "Delete worktree", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.worktreeDeletes))
    .toEqual([{ path: "D:\\worktrees\\one", force: true }]);
});

test("Settings saves and clears the server worktree directory", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Worktree directory" });
  await field.fill("/server/custom worktrees");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.composerFixture.settingsWrites.at(-1) as { worktreeDirectory?: string })
            ?.worktreeDirectory,
      ),
    )
    .toBe("/server/custom worktrees");
  await field.fill("");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.composerFixture.settingsWrites.at(-1) as { worktreeDirectory?: string | null })
            ?.worktreeDirectory,
      ),
    )
    .toBeNull();
});

test("creation disables worktrees for non-Git folders and uses worktree creation for eligible ones", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  const folder = page.getByRole("textbox", { name: "Project folder", exact: true });
  const worktree = page.getByRole("checkbox", { name: "Start in a new Git worktree" });
  await folder.fill("/not-git");
  await expect(worktree).toBeDisabled();
  await folder.fill("/source/repository");
  await expect(worktree).toBeEnabled();
  await worktree.check();
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.worktreeSwitches))
    .toEqual([{ kind: "create", cwd: "/source/repository" }]);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
});

test("feedback icons share Copy’s row and submit the actual conversation route", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.waitForFunction(() => window.composerFixture !== undefined);
  await page.evaluate(() => window.composerFixture.showMarkdown());
  const message = page.getByTestId("assistant-message");
  await message.hover();
  const actions = message.locator(".message-actions");
  await expect(actions.getByRole("button", { name: "Copy message" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Thumbs up", exact: true })).toBeVisible();
  await actions.getByRole("button", { name: "Thumbs down", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Optional feedback comment" })
    .fill("Keep the original API");
  await page.getByRole("button", { name: "Save feedback", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Negative feedback" }).getByRole("status"),
  ).toContainText("saved");
  expect(await page.evaluate(() => window.composerFixture.feedbackCalls)).toEqual([
    expect.objectContaining({
      conversationId: "fixture",
      itemId: "markdown",
      vote: "down",
      comment: "Keep the original API",
    }),
  ]);
});

test("activities label their full subagent chain and keep Stop compact beside Running", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.waitForFunction(() => window.composerFixture !== undefined);
  await page.evaluate(() => {
    window.composerFixture.showSubagents();
    window.composerFixture.showOwnedActivity();
  });
  await page.locator(".activities > summary").click();
  const activity = page.locator(".activity");
  await expect(activity.locator(".activity-owner .ancestor a")).toHaveText([
    "Parent conversation",
    "Review authentication",
    "Check tests",
  ]);
  const stop = activity.getByRole("button", { name: "Stop activity", exact: true });
  const box = (await stop.boundingBox())!;
  expect(box.width).toBe(22);
  expect(box.height).toBe(22);
});

test("settings saves configurable subagent depth and active child limits", async ({ page }) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  const depth = page.getByRole("spinbutton", { name: /Subagent depth/ });
  const children = page.getByRole("spinbutton", { name: /Active children per agent/ });
  await expect(depth).toHaveValue("2");
  await expect(children).toHaveValue("3");
  await depth.fill("4");
  await children.fill("5");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({ subagents: { maxDepth: 4, maxChildren: 5 } });
});

test("question batches allow clearable choices and comments, and show submission errors", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showQuestions());
  const form = page.getByRole("region", { name: "Agent questions" });
  const comments = form.getByRole("textbox");
  await expect(form.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(form.getByText("Question 1 of 3", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Gamma", { exact: true })).toHaveCount(0);
  await form.getByLabel("Alpha", { exact: true }).check();
  await form.getByLabel("Beta", { exact: true }).check();
  await expect(form.getByLabel("Alpha", { exact: true })).not.toBeChecked();
  await form.getByLabel("Beta", { exact: true }).uncheck();
  await comments.fill("Neither option fits");
  await expect(comments).toHaveJSProperty("tagName", "INPUT");
  await comments.press("Enter");
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([]);
  await form.getByRole("button", { name: "Hide questions", exact: true }).click();
  await expect(comments).toBeHidden();
  await expect(form.getByRole("button", { name: "Show questions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([]);
  await form.getByRole("button", { name: "Show questions", exact: true }).click();
  await expect(comments).toHaveValue("Neither option fits");
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await expect(form.getByText("Question 2 of 3", { exact: true })).toBeVisible();
  await form.getByLabel("Gamma", { exact: true }).check();
  await form.getByLabel("Delta", { exact: true }).check();
  await comments.fill("Both with a comment");
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await expect(comments).toHaveValue("Neither option fits");
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await expect(comments).toHaveValue("Both with a comment");
  await expect(form.getByLabel("Gamma", { exact: true })).toBeChecked();
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await comments.fill("Freeform answer");
  await page.evaluate(() => {
    window.composerFixture.failQuestionResponse = true;
  });
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form.getByRole("alert")).toHaveText("Question response rejected");
  await expect(comments).toHaveValue("Freeform answer");
  await page.evaluate(() => {
    window.composerFixture.failQuestionResponse = false;
  });
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([
    {
      status: "answered",
      answers: [
        { questionId: "single", selectedOptionIds: [], comment: "Neither option fits" },
        { questionId: "multiple", selectedOptionIds: ["c", "d"], comment: "Both with a comment" },
        { questionId: "freeform", selectedOptionIds: [], comment: "Freeform answer" },
      ],
    },
  ]);
});

test("question dismissal is explicit and does not require filling the form", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showQuestions());
  const form = page.getByRole("region", { name: "Agent questions" });
  await form.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([
    { status: "dismissed" },
  ]);
});

test("read-only child views can dismiss their issued questions", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Subagents", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.composerFixture.showSubagents();
    window.composerFixture.showQuestions("review");
  });
  await page.getByRole("button", { name: "Subagents · 1 running", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Subagents", exact: true })
    .getByRole("link", { name: "Review authentication", exact: true })
    .click();
  await expect(page.locator(".conversation-header h1")).toHaveText("Review authentication");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  const form = page.getByRole("region", { name: "Agent questions" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([
    { status: "dismissed" },
  ]);
});

for (const viewport of [
  { width: 1174, height: 887 },
  { width: 900, height: 650 },
]) {
  test(`current question fits without scrolling at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(url + "?composer");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.evaluate(() => window.composerFixture.showQuestions());
    const form = page.getByRole("region", { name: "Agent questions" });
    await expect(form.getByRole("textbox")).toBeVisible();
    await expect(form.getByRole("button", { name: "Next", exact: true })).toBeVisible();
    for (const selector of [
      ".question-request",
      ".conversation-support",
      ".conversation-dock-content",
    ])
      expect(
        await page
          .locator(selector)
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(1);
    const bounds = (await form.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThan(viewport.height);
    if (viewport.width === 1174)
      await page.screenshot({ path: "/tmp/harness-question-layout.png" });
  });
}

test("each question can be explicitly skipped without dismissing the batch", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.evaluate(() => window.composerFixture.showQuestions());
  const form = page.getByRole("region", { name: "Agent questions" });
  await form.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(form.getByText("Question 2 of 3", { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await expect(form.getByText("Choose one (skipped)", { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await form.getByRole("textbox").fill("Only answer this question");
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await form.getByRole("button", { name: "Skip", exact: true }).click();
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([]);
  await form.getByRole("button", { name: "Submit answers", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.composerFixture.questionResponses)).toEqual([
    {
      status: "answered",
      answers: [
        { questionId: "single", skipped: true },
        { questionId: "multiple", selectedOptionIds: [], comment: "Only answer this question" },
        { questionId: "freeform", skipped: true },
      ],
    },
  ]);
});

const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP578LwHwAF4AJH4fprIAAAAABJRU5ErkJggg==";
async function attachFixtureImage(page: Page, event: "paste" | "drop") {
  await page.getByRole("textbox", { name: "Message", exact: true }).evaluate(
    (element, args) => {
      const bytes = Uint8Array.from(atob(args.data), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "test.png", { type: "image/png" }));
      element.dispatchEvent(
        args.event === "paste"
          ? new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    },
    { data: imageBase64, event },
  );
  await expect(page.locator(".composer .image-preview")).toHaveCount(1);
}

test("real browser clipboard paste attaches an image without native APIs", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(url + "?composer");
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
    ]);
  }, imageBase64);
  await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".composer .image-preview")).toHaveCount(1);
  await expect(page.locator(".composer .image-preview img")).toHaveJSProperty("naturalWidth", 1);
});

for (const mimeType of ["image/png", "", "application/octet-stream"]) {
  test(`paperclip reads image bytes with MIME ${mimeType || "empty"} before the model control`, async ({
    page,
  }) => {
    await page.goto(url + "?composer");
    const paperclip = page.getByRole("button", { name: "Attach images", exact: true });
    const model = page.getByRole("button", { name: "Model and preset: Fixture model" });
    expect((await paperclip.boundingBox())!.x).toBeLessThan((await model.boundingBox())!.x);
    const chooser = page.waitForEvent("filechooser");
    await paperclip.click();
    await (
      await chooser
    ).setFiles({
      name: "screenshot",
      mimeType,
      buffer: Buffer.from(imageBase64, "base64"),
    });
    await expect(page.locator(".composer .image-preview")).toHaveCount(1);
    await expect(page.locator(".composer .image-preview img")).toHaveJSProperty("naturalWidth", 1);
    await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
  });
}

for (const event of ["paste", "drop"] as const) {
  test(`image ${event} supports preview, full viewer, image-only send, and removal`, async ({
    page,
  }) => {
    await page.goto(url + "?composer");
    await attachFixtureImage(page, event);
    await page.getByRole("button", { name: "Open image 1", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "Image 1", exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 1);
    await expect(viewer).toHaveCSS("width", `${page.viewportSize()!.width}px`);
    await viewer.getByRole("button", { name: "Close dialog" }).click();
    await expect(viewer).toBeHidden();
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.composerFixture.calls))
      .toEqual([
        {
          text: "",
          intent: "steer",
          images: [{ type: "image", mediaType: "image/png", data: imageBase64 }],
        },
      ]);
    await page.evaluate(() => window.composerFixture.settle(true));
    await expect(page.getByRole("button", { name: "Remove image 1" })).toBeVisible();
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.composerFixture.calls.length)).toBe(2);
    await page.evaluate(() => window.composerFixture.settle());
    await expect(page.locator(".composer .image-preview")).toHaveCount(0);
    await attachFixtureImage(page, event);
    await page.getByRole("button", { name: "Remove image 1" }).click();
    await expect(page.locator(".composer .image-preview")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  });
}

test("pending image reads stay observable after leaving and reopening the chat", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("keep draft");
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")!
      .value as FileReader["readAsDataURL"];
    FileReader.prototype.readAsDataURL = function (file) {
      FileReader.prototype.readAsDataURL = original;
      (window as typeof window & { releaseImageRead: () => void }).releaseImageRead = () =>
        original.call(this, file);
    };
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach images", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "slow.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageBase64, "base64"),
  });
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.locator('a[href="/conversations/fixture"]').first().click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
    "keep draft",
  );
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
  await page.evaluate(() =>
    (window as typeof window & { releaseImageRead: () => void }).releaseImageRead(),
  );
  await expect(page.locator(".composer .image-preview")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
});

test("accepted image delivery preserves attachments added while sending", async ({ page }) => {
  await page.goto(url + "?composer");
  await attachFixtureImage(page, "paste");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls.length)).toBe(1);
  await page.getByRole("textbox", { name: "Message", exact: true }).evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "next.png", {
        type: "image/png",
      }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  }, imageBase64);
  await expect(page.locator(".composer .image-preview")).toHaveCount(2);
  await page.evaluate(() => window.composerFixture.settle());
  await expect(page.locator(".composer .image-preview")).toHaveCount(1);
});

test("user and tool image history show previews and full viewer", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(
    (data) => window.composerFixture.showImages([{ type: "image", mediaType: "image/png", data }]),
    imageBase64,
  );
  await expect(page.locator(".cell.user .image-preview")).toHaveCount(1);
  const trigger = page.locator(".cell.user").getByRole("button", { name: "Open image 1" });
  const viewer = page.getByRole("dialog", { name: "Image 1", exact: true });
  await trigger.click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole("img").click();
  await expect(viewer).toBeVisible();
  await viewer.click({ position: { x: 8, y: 8 } });
  await expect(viewer).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(viewer).toBeVisible();
  await expect(viewer).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const close = viewer.getByRole("button", { name: "Close dialog" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await viewer.focus();
    await close.hover();
    await expect(close).toHaveCSS("background-color", "rgba(255, 255, 255, 0.12)");
    await expect(close.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS("background-color", "rgba(255, 255, 255, 0.12)");
    await expect(close.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(close).toHaveCSS("outline-color", "rgba(255, 255, 255, 0.5)");
    await expect(close).toHaveCSS("outline-style", "solid");
  }
  await expect(page.getByRole("tooltip", { name: "Close dialog", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await close.click();
  await expect(viewer).toBeHidden();
  await page.getByTestId("tool-call").locator("summary").click();
  await expect(page.getByTestId("tool-call").locator(".image-preview")).toHaveCount(1);
});
