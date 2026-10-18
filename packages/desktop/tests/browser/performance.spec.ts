import { test, expect } from "@playwright/test";
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
    plugins: [
      {
        name: "render-observations",
        enforce: "pre",
        transform(source, id) {
          if (!id.endsWith("/src/routes.tsx")) return;
          // Count actual production component execution in the test bundle only.
          for (const name of [
            "Layout",
            "ConversationPage",
            "Composer",
            "TranscriptCell",
            "ToolBody",
            "ConversationHeading",
          ]) {
            const pattern = new RegExp(`function ${name}\\([\\s\\S]*?\\) \\{`);
            if (!pattern.test(source)) throw new Error(`Missing instrumented component ${name}`);
            source = source.replace(
              pattern,
              (match) =>
                match +
                `\n(window.renderCounts ??= {}).${name} = (window.renderCounts.${name} ?? 0) + 1;\n`,
            );
          }
          return source;
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: fileURLToPath(new URL("performance-fixture.ts", import.meta.url)) },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Unexpected fixture output");
  const assets = new Map(
    result.output.map((asset) => [
      "/" + asset.fileName,
      asset.type === "chunk" ? asset.code : asset.source,
    ]),
  );
  const entry = result.output.find((asset) => asset.type === "chunk" && asset.isEntry);
  if (!entry) throw new Error("Missing fixture entry");
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
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

test("bursty streaming updates only live text and leaves composer/header/sidebar and collapsed diffs alone", async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.performanceFixture.seed());
  await expect(page.getByText("Stable visible message", { exact: true })).toBeVisible();
  await expect(page.getByTestId("tool-call")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my draft");
  await page.evaluate(() => window.performanceFixture.reset());
  await page.evaluate(() => window.performanceFixture.burst(500));
  await expect(page.getByTestId("assistant-message").last()).toContainText(
    "Live" + "x".repeat(500),
  );
  const counts = await page.evaluate(() => window.performanceFixture.counts());
  await test.info().attach("stream-render-work", {
    body: JSON.stringify(counts),
    contentType: "application/json",
  });
  expect(counts.Composer ?? 0).toBe(0);
  expect(counts.ConversationHeading ?? 0).toBe(0);
  expect(counts.Layout ?? 0).toBe(0);
  expect(counts.ToolBody ?? 0).toBe(0);
  expect(counts.TranscriptCell).toBeGreaterThan(0);
  expect(counts.TranscriptCell).toBeLessThanOrEqual(2); // Visible instance + virtualizer measurement.
  expect(counts.projection).toBeLessThanOrEqual(2);
  await expect(composer).toHaveValue("Keep my draft");
  await page.getByTestId("tool-call").locator("summary").click();
  await expect(page.locator(".edit-diff")).toBeVisible();
  expect((await page.evaluate(() => window.performanceFixture.counts())).ToolBody).toBeGreaterThan(
    0,
  );
  await page.evaluate(() => {
    window.performanceFixture.burst(1);
    window.performanceFixture.finish();
  });
  await expect(page.getByTestId("assistant-message").last()).toContainText(
    "Live" + "x".repeat(501),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep my draft");
});

test("memoized rename and fork controls still respond to disconnect", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.performanceFixture.seed());
  const rename = page.getByRole("button", { name: "Rename conversation" });
  const fork = page.getByRole("button", { name: "Fork before this message" });
  await expect(rename).toBeEnabled();
  await expect(fork).toBeEnabled();
  await page.evaluate(() => window.composerFixture.disconnect());
  await expect(rename).toBeDisabled();
  await expect(fork).toBeDisabled();
});

test("restart checks current background work when clicked", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.evaluate(() => window.performanceFixture.finish());
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Application", exact: true }).click();
  const restart = page.getByRole("button", { name: "Restart Harness", exact: true });
  await expect(restart).toBeVisible();
  await page.evaluate(() => window.performanceFixture.startActivityWithoutNotification());
  await restart.click();
  await expect(page.getByRole("alertdialog", { name: "Restart Harness?" })).toBeVisible();
});
