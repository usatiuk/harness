import { expect, type Page } from "@playwright/test";

export async function showModelControls(page: Page): Promise<void> {
  if (!(await page.getByLabel("Conversation model", { exact: true }).isVisible()))
    await page.getByRole("button", { name: /^Model and preset:/u }).click();
}
export async function showSandboxControls(page: Page): Promise<void> {
  if (!(await page.getByLabel("Conversation sandbox", { exact: true }).isVisible()))
    await page.getByRole("button", { name: /^Sandbox:/u }).click();
}
export async function manageConnections(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Switch host:/u }).click();
  await page.getByRole("button", { name: "Manage connections", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connections", exact: true })).toBeVisible();
  await page
    .getByRole("dialog", { name: "Connections", exact: true })
    .getByText("Server actions", { exact: true })
    .click();
}
export async function settingsSection(
  page: Page,
  name: "Appearance" | "Composer" | "Defaults" | "Providers" | "Application",
): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
}
export async function switchHost(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: /^Switch host:/u }).click();
  await page
    .getByRole("dialog", { name: "Hosts", exact: true })
    .getByRole("button", { name: new RegExp(`^${label}`, "u") })
    .click();
}
