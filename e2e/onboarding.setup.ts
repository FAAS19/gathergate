import { expect, test as setup } from "@playwright/test";
import { expectAccessible, OPERATOR, screenshot, trackErrors } from "./helpers";

setup("first-run onboarding creates the workspace", async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await expectAccessible(page, testInfo, "setup");

  await page.getByLabel("Practice name").fill(OPERATOR.workspace);
  // The live preview mirrors the practice name as the operator types.
  await expect(page.locator("aside").getByText(OPERATOR.workspace)).toBeVisible();
  await page.getByLabel("Your email").fill(OPERATOR.email);
  await page.getByLabel("Password", { exact: true }).fill("short");
  await expect(page.getByText("At least 10 characters")).toBeVisible();
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByLabel("Password", { exact: true }).fill(OPERATOR.password);
  await screenshot(page, testInfo, "setup");

  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
  expect(errors).toEqual([]);

  await page.context().storageState({ path: "e2e/.auth/operator.json" });
});
