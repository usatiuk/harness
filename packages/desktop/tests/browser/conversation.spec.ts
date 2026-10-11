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
        `<html><head>${css}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`,
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
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(4);
  const output = await tool.locator("pre").boundingBox();
  const dock = await page.locator(".conversation-dock").boundingBox();
  expect(output!.y + output!.height).toBeLessThanOrEqual(dock!.y);
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
  const text = await page.locator(".conversation-scroll").evaluate((element) => {
    const top = element.querySelector(".conversation-header")!.getBoundingClientRect().bottom;
    const visible = [...element.querySelectorAll(".user-text")].find(
      (row) => row.getBoundingClientRect().top >= top,
    );
    if (!visible?.textContent) throw new Error("No visible user message to anchor");
    return visible.textContent;
  });
  const anchor = page.getByText(text, { exact: true });
  await expect(anchor).toBeVisible();
  const before = await anchor.boundingBox();
  await page.evaluate(() => window.canvasFixture.prepend());
  // Header measurement rounds to nearest pixel, then scroll targets round upward.
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before!.y))
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
    const top = element.querySelector(".conversation-header")!.getBoundingClientRect().bottom;
    const child = [...element.querySelectorAll(".transcript-item")].find(
      (row) => row.querySelector(".cell.tool") && row.getBoundingClientRect().bottom > top,
    );
    if (!child) throw new Error("No child to read");
    element.scrollTop += child.getBoundingClientRect().top - top + 4;
  });
  await expect
    .poll(() =>
      page.locator(".conversation-scroll").evaluate((element) => {
        const top = element.querySelector(".conversation-header")!.getBoundingClientRect().bottom;
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
    const top = element.querySelector(".conversation-header")!.getBoundingClientRect().bottom;
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
  await expect(page.getByRole("tooltip")).toContainText("262,144 context tokens");
  await expect(page.getByRole("tooltip")).toContainText("Presets: none, high");
  expect(
    await first.locator(".model-id").evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(await first.evaluate((element) => getComputedStyle(element).color));
  await first.click();
  await expect(
    page.getByRole("combobox", { name: "Conversation preset" }).locator("option"),
  ).toHaveText(["Default", "none", "high"]);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  const preset = page.getByRole("combobox", { name: "New conversation preset" });
  await expect(preset.locator("option")).toHaveText(["Default", "none", "high"]);
  await preset.selectOption("high");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.creations.at(-1)))
    .toMatchObject({
      overrides: { model: { provider: "fixture", model: "test", preset: "high" } },
    });
  await page.getByRole("link", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await preset.selectOption("high");
  const newModels = page.getByRole("combobox", { name: "New conversation model" });
  await newModels.click();
  await page
    .getByRole("option", { name: "fixture / Fixture model test-latest", exact: true })
    .click();
  await expect(preset).toHaveCount(0);
  await newModels.click();
  await page.getByRole("option", { name: "fixture / Fixture model test", exact: true }).click();
  await expect(preset).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create conversation", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.creations.at(-1)?.overrides?.model))
    .toEqual({ provider: "fixture", model: "test" });
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
  await message.press("Control+.");
  await expect(primary).toHaveText("Stopping…");
  await expect(primary).toBeDisabled();
  await message.press("Control+.");
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
  await message.press("Control+.");
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
  await page.locator("select[name=inWorkspace]").selectOption("ask-human");
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

test("provider settings expose and save native web search for supported connections", async ({
  page,
}) => {
  await page.goto(url + "?composer");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  const work = page
    .locator(".provider")
    .filter({ has: page.getByRole("heading", { name: "Work", exact: true }) });
  await expect(page.getByLabel("Work Web search", { exact: true })).toHaveValue("true");
  await expect(page.getByLabel("Personal Web search", { exact: true })).toHaveValue("false");
  await expect(page.getByLabel("Gateway Web search", { exact: true })).toHaveCount(0);
  await page.getByLabel("Work Web search", { exact: true }).selectOption("false");
  await work.getByRole("button", { name: "Save provider settings", exact: true }).click();
  await expect(work.getByRole("status")).toContainText("Restart the server");
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.providerWrites))
    .toEqual([{ provider: "work", patch: { webSearch: false } }]);
  await page.getByRole("tab", { name: "Defaults", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  await expect(page.getByLabel("Work Web search", { exact: true })).toHaveValue("false");
  await page.getByLabel("Work Web search", { exact: true }).selectOption("true");
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
  await page.getByLabel("Work Compact output", { exact: true }).selectOption("false");
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
  await page.locator("select[name=titlePreset]").selectOption("high");
  await page.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.composerFixture.settingsWrites.at(-1)))
    .toMatchObject({
      conversationTitleModel: { provider: "fixture", model: "test", preset: "high" },
    });
  await naming.click();
  await page.getByRole("option", { name: "Use conversation model", exact: true }).click();
  await expect(page.locator("select[name=titlePreset]")).toBeDisabled();
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
  const group = page.locator(".tool-group");
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thinking for 0 seconds · 2 tool calls",
  );
  await expect(group).not.toHaveAttribute("open", "");
  await group.locator(":scope > summary").click();
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
  await expect(group.locator(":scope > summary")).toHaveText("Thought · 100 tool calls");
  await expect(group.getByTestId("tool-call")).toHaveCount(0);
  await expect(group.locator(".diff span")).toHaveCount(0);
  await group.locator(":scope > summary").click();
  await expect(group.getByTestId("tool-call")).toHaveCount(100);
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
});

test("reasoning and tool calls share a collapsed group between messages", async ({ page }) => {
  await page.goto(url + "?composer");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => {
    window.composerFixture.showToolsAndActivities(-60_000);
    window.composerFixture.insertReasoning();
  });
  const group = page.locator(".tool-group");
  await expect(group).toHaveCount(1);
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thinking for 0 seconds · 2 tool calls",
  );
  await page.clock.runFor(2000);
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thinking for 2 seconds · 2 tool calls",
  );
  await expect(group.locator(".reasoning")).toHaveCount(0);
  await group.locator(":scope > summary").click();
  await expect(group.locator(".reasoning")).toHaveText("Checking credential ownership");
  await expect(group.locator(".reasoning summary")).toHaveCount(0);
  await expect(group.getByTestId("tool-call")).toHaveCount(2);
  const label = await group.locator(":scope > summary").boundingBox();
  const icon = await group.locator(".tool-icon").first().boundingBox();
  expect(Math.abs(icon!.x - label!.x)).toBeLessThanOrEqual(1);
  await expect(group.locator(".reasoning")).toContainText("Checking credential ownership");
  await expect(page.getByTestId("assistant-message")).toHaveText("Checking the stores");
  await page.clock.runFor(10_000);
  await page.evaluate(() => window.composerFixture.completeSteps());
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thought for 12 seconds · 2 tool calls",
  );
  await page.clock.runFor(2000);
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thought for 12 seconds · 2 tool calls",
  );
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
  const group = page.locator(".tool-group");
  await expect(group.locator(":scope > summary")).toHaveText(
    "Thought for 12 seconds · 3 tool calls",
  );
  await expect(group.getByTestId("tool-call")).toHaveCount(0);
  await group.locator(":scope > summary").click();
  const calls = group.locator(":scope > .tool");
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
  const icon = await read.locator(".tool-icon").boundingBox();
  const chevron = await read.locator(".disclosure-chevron").boundingBox();
  const name = await read.locator("strong").boundingBox();
  expect(icon!.x).toBeLessThan(name!.x);
  expect(chevron!.x).toBeGreaterThan(name!.x + name!.width);
  await read.locator("summary").focus();
  await page.keyboard.press("Enter");
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
