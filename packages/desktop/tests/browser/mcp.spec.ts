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
    build: {
      write: false,
      rollupOptions: { input: fileURLToPath(new URL("mcp-fixture.ts", import.meta.url)) },
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

test("edits stdio and HTTP/OAuth servers with shared permissions and separate masked credentials", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByLabel("Server ID", { exact: true }).fill("local");
  await page.getByLabel("Executable", { exact: true }).fill("node");
  await page.getByLabel("Arguments (one per line)").fill("server.js\n--verbose");
  await page.getByRole("button", { name: "Add value", exact: true }).click();
  await page.getByLabel("Host variable name", { exact: true }).fill("TOKEN");
  await page.getByLabel("Exact MCP tool name").fill("mutate");
  await page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Tool overrides" }) })
    .getByRole("combobox")
    .last()
    .selectOption("ask-human");
  await page.getByRole("button", { name: "Add tool rule" }).click();
  await page.getByRole("button", { name: "Save server", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.getByLabel("Credential", { exact: true }).fill("private-value");
  await expect(page.getByLabel("Credential", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Replace credential" }).click();
  await expect(page.getByLabel("Credential", { exact: true })).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("Credential stored");
  await expect(page.locator("body")).not.toContainText("private-value");
  await page.getByRole("button", { name: "Test saved connection" }).click();
  await expect(page.getByRole("status")).toContainText("ready · 2 tools");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByLabel("Server ID", { exact: true }).fill("hosted");
  await page.getByLabel("Transport", { exact: true }).selectOption("http");
  await page.getByLabel("HTTP endpoint", { exact: true }).fill("https://example.com/mcp");
  await page.getByLabel("Authentication", { exact: true }).selectOption("oauth");
  await page.getByLabel("Pre-registered client ID", { exact: true }).fill("registered");
  const secret = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "OAuth client secret" }) });
  await secret.getByLabel("Source", { exact: true }).selectOption("secret");
  await secret.getByLabel("Credential slot", { exact: true }).fill("client-key");
  await page.getByRole("button", { name: "Add value", exact: true }).click();
  await page.getByLabel("Host variable name", { exact: true }).fill("CUSTOM_HEADER");
  await page.getByRole("button", { name: "Save server", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  const saved = await page.evaluate(
    () =>
      window.mcpFixture.calls.filter((call) => call.method === "plugin.mcp.settings.set").at(-1)
        ?.params,
  );
  expect(saved).toMatchObject({
    config: {
      servers: {
        local: {
          tools: { mutate: "ask-human" },
          transport: { env: { VARIABLE: { type: "env", name: "TOKEN" } } },
        },
        hosted: {
          transport: {
            auth: {
              type: "oauth",
              clientId: "registered",
              clientSecret: { type: "secret", slot: "client-key" },
            },
            headers: { "X-Header": { type: "env", name: "CUSTOM_HEADER" } },
          },
        },
      },
    },
  });
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mcpFixture.opened))
    .toEqual(["https://example.com/authorize?state=fixture-state"]);
  const callbackUrl = "http://127.0.0.1:4321/auth/callback?state=fixture-state&code=one";
  await page.getByLabel("Redirected URL", { exact: true }).fill(callbackUrl);
  await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Signed in");
  expect(
    await page.evaluate(
      () => window.mcpFixture.calls.find((c) => c.method === "plugin.mcp.auth.complete")?.params,
    ),
  ).toEqual({ attemptId: "fixture-attempt", callbackUrl });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Signed out");
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Complete sign-in", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("mcp-settings.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel sign-in", exact: true })).toBeVisible();
  const after = await page.evaluate(() => window.mcpFixture.calls.length);
  await page.evaluate(() => window.mcpFixture.unmount());
  await expect
    .poll(() => page.evaluate((index) => window.mcpFixture.calls.slice(index), after))
    .toContainEqual({ method: "plugin.mcp.auth.cancel", params: { attemptId: "fixture-attempt" } });
});

test("cancels an owned OAuth attempt when saving removes its server", async ({ page }) => {
  await page.goto(url);
  for (const id of ["other", "hosted"]) {
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    await page.getByLabel("Server ID", { exact: true }).fill(id);
    await page.getByLabel("Transport", { exact: true }).selectOption("http");
    await page.getByLabel("HTTP endpoint", { exact: true }).fill("https://example.com/mcp");
    await page.getByLabel("Authentication", { exact: true }).selectOption("oauth");
    await page.getByRole("button", { name: "Save server", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved");
  }
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel sign-in", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.mcpFixture.otherSigningIn = true;
  });
  await page.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel sign-in", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.mcpFixture.unmount());
  expect(
    await page.evaluate(() =>
      window.mcpFixture.calls.filter((call) => call.method === "plugin.mcp.auth.cancel"),
    ),
  ).toEqual([{ method: "plugin.mcp.auth.cancel", params: { attemptId: "fixture-attempt" } }]);
});
