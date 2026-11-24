import { expect, test } from "@playwright/test";
import { expectAccessible, OPERATOR, screenshot, trackErrors } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test("operator signs in with a clean, accessible login", async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expectAccessible(page, testInfo, "login");
  await screenshot(page, testInfo, "login");

  await page.getByLabel("Email").fill(OPERATOR.email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid email or password.");

  await page.getByLabel("Password", { exact: true }).fill(OPERATOR.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  // The 401 from the failed attempt is expected; nothing else may error.
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});
