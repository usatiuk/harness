import { test, expect, type Page } from "@playwright/test";
import { build } from "vite";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

interface Fixture {
  ready: boolean;
  setCwd(next: string): void;
}
declare global {
  interface Window {
    newWorktreeFixture?: Fixture;
  }
}

let server: Server;
let url: string;
test.beforeAll(async () => {
  const result = await build({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    logLevel: "error",
    build: {
      write: false,
      rollupOptions: { input: fileURLToPath(new URL("new-worktree-fixture.ts", import.meta.url)) },
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

const formData = (page: Page) =>
  page.locator("form").evaluate((form) => new FormData(form as HTMLFormElement).get("newWorktree"));

test("worktree option is a compact native checkbox, not a full-width input pill", async ({
  page,
}) => {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => window.newWorktreeFixture?.ready)).toBe(true);
  const checkbox = page.getByRole("checkbox", { name: "Start in a new Git worktree" });
  const label = page.locator("label.check-label");
  await expect(checkbox).toBeVisible();
  const box = (await checkbox.boundingBox())!;
  const formBox = (await page.locator("form.creation-form").boundingBox())!;
  // Regression: the option was rendered with the .input field styles, a
  // full-width bordered pill; it must stay a 16px native square.
  expect(await checkbox.getAttribute("class")).not.toMatch(/(^|\s)input(\s|$)/);
  expect(box.width).toBeGreaterThanOrEqual(14);
  expect(box.height).toBeGreaterThanOrEqual(14);
  expect(box.width).toBeLessThan(formBox.width * 0.3);
  expect(await label.evaluate((element) => getComputedStyle(element).marginTop)).toBe("12px");

  await checkbox.check();
  expect(await formData(page)).toBe("on");
  await checkbox.uncheck();
  expect(await formData(page)).toBeNull();

  await page.evaluate(() => window.newWorktreeFixture?.setCwd("/not-a-repo"));
  await expect(checkbox).toBeDisabled();
  expect(await formData(page)).toBeNull();
  await page.evaluate(() => window.newWorktreeFixture?.setCwd("/repo"));
  await expect(checkbox).toBeEnabled();
});
