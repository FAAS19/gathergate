import { expect, test } from "@playwright/test";
import { expectAccessible, PNG, screenshot, trackErrors } from "./helpers";

test("operator configures branding RGB picker, email delivery, account profile and views standalone outbox", async ({
  page,
}, testInfo) => {
  const errors = trackErrors(page);
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Branding", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByLabel("Upload logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByAltText("Current logo")).toBeVisible();

  // Colour palette popover syncs RGB channels back to HEX.
  await page.getByRole("button", { name: "Open colour palette" }).click();
  await page.getByLabel("Red").fill("30");
  await page.getByLabel("Green").fill("58");
  await page.getByLabel("Blue").fill("95");
  await expect(page.getByLabel("Accent colour", { exact: true })).toHaveValue("#1E3A5F");
  await page.keyboard.press("Escape");

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

  // Email Delivery: Gmail preset autofills host, Local Outbox test captures message.
  await page.getByRole("button", { name: "Email Delivery", exact: true }).click();
  await expect(page.getByRole("button", { name: "Email Delivery", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("radio", { name: /SMTP Server/ }).click();
  await page.getByRole("button", { name: "Gmail", exact: true }).click();
  await expect(page.getByLabel("SMTP host")).toHaveValue("smtp.gmail.com");

  await page.getByRole("radio", { name: /Local Outbox/ }).click();
  await page.getByRole("button", { name: "Send test email", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test email captured in Local Outbox" })).toBeVisible();

  // Account & Security: update display name and verify sidebar reflects it.
  await page.getByRole("button", { name: "Account & Security", exact: true }).click();
  await page.getByLabel("Display name").fill("Sarah Mitchell");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sarah Mitchell/ })).toBeVisible();

  // API Keys: create scoped key, verify one-time secret works via Bearer auth, check Light & Dark WCAG AA, then revoke.
  await page.goto("/settings?section=api-keys");
  await expect(page.getByRole("button", { name: "API Keys", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Key label").fill("n8n Intake Automation");
  await page.getByRole("button", { name: "Create API key" }).click();
  const secretEl = page.getByTestId("new-api-key-secret");
  await expect(secretEl).toBeVisible();
  const rawSecret = (await secretEl.textContent())?.trim() ?? "";
  expect(rawSecret.startsWith("gg_live_")).toBe(true);

  const bearerReq = await page.request.get("/api/requests", {
    headers: { authorization: `Bearer ${rawSecret}` },
  });
  expect(bearerReq.status()).toBe(200);

  await expectAccessible(page, testInfo, "settings-api-keys-light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expectAccessible(page, testInfo, "settings-api-keys-dark");
  await page.getByRole("button", { name: "Switch to daylight mode" }).click();

  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();

  const revokedReq = await page.request.get("/api/requests", {
    headers: { authorization: `Bearer ${rawSecret}` },
  });
  expect(revokedReq.status()).toBe(401);

  // Webhooks: delivery log section renders cleanly in Light & Dark modes.
  await page.goto("/settings?section=webhooks");
  await expect(page.getByText("Recent Deliveries & Dead-Letter Queue")).toBeVisible();
  await expectAccessible(page, testInfo, "settings-webhooks-light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expectAccessible(page, testInfo, "settings-webhooks-dark");
  await page.getByRole("button", { name: "Switch to daylight mode" }).click();

  // Standalone Local Email Outbox page renders invites + test email with branded HTML iframe.
  await page.goto("/outbox");
  await expect(page.getByRole("heading", { name: "Local Email Outbox" })).toBeVisible();
  await page.getByRole("button", { name: /needs a few documents from you/ }).first().click();
  const preview = page.frameLocator("iframe[title^='Preview of']");
  await expect(preview.getByRole("link", { name: "Open checklist" })).toBeVisible();
  await screenshot(page, testInfo, "outbox-email");
  // The preview sandbox refusing script (logged when Playwright probes the frame) is the protection working.
  expect(errors.filter((e) => !e.includes("frame is sandboxed and the 'allow-scripts' permission is not set"))).toEqual([]);
});
