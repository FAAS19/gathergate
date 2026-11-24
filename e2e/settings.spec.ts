import { expect, test } from "@playwright/test";
import { PNG, screenshot, trackErrors } from "./helpers";

test("operator brands the portal and previews the branded client email", async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: "Branding" })).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("Upload logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByAltText("Current logo")).toBeVisible();

  // Too-light colours are refused before they reach the server.
  await page.getByLabel("Accent colour", { exact: true }).fill("#F5D90A");
  await expect(page.getByText("This colour is too light to read on white.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save branding" })).toBeDisabled();

  await page.getByLabel("Accent colour", { exact: true }).fill("#7C2D12");
  await page.getByLabel("Support email").fill("help@harbour.test");
  await page.getByRole("button", { name: "Save branding" }).click();
  await expect(page.getByText("Branding saved")).toBeVisible();
  await screenshot(page, testInfo, "settings-branding");

  const session = (await (await page.request.get("/api/session")).json()) as {
    workspace: { brand_color: string; has_logo: boolean };
  };
  expect(session.workspace).toMatchObject({ brand_color: "#7C2D12", has_logo: true });

  // Invites sent earlier (sample data and other specs) sit in the Local Outbox as branded HTML.
  await page.goto("/outbox");
  await page.getByRole("button", { name: /needs a few documents from you/ }).first().click();
  const preview = page.frameLocator("iframe[title^='Preview of']");
  await expect(preview.getByRole("link", { name: "Open checklist" })).toBeVisible();
  await screenshot(page, testInfo, "outbox-email");
  // The preview sandbox refusing script (logged when Playwright probes the frame) is the protection working.
  expect(errors.filter((e) => !e.includes("frame is sandboxed and the 'allow-scripts' permission is not set"))).toEqual([]);
});
