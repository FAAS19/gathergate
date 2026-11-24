import { expect, test } from "@playwright/test";
import { expectAccessible, PDF, PNG, screenshot, trackErrors } from "./helpers";

test("client completes a branded, OTP-protected checklist end to end", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const clientEmail = `claire+${project}@client.test`;

  // Operator brands the workspace and sends a request (via API; the operator UI has its own tests).
  const branding = await page.request.put("/api/settings/branding", {
    data: {
      brandColor: "#1D4ED8",
      supportEmail: "help@harbour.test",
      supportPhone: "+61 3 9000 0000",
      logoDataUrl: null,
    },
  });
  expect(branding.ok()).toBeTruthy();
  const created = await page.request.post("/api/requests", {
    data: {
      title: "FY26 tax return",
      clientName: "Claire Nguyen",
      clientEmail,
      requireOtp: true,
      welcomeNote: "Thanks Claire. Everything we need for this year is below.",
      dueAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
      items: [
        { section: "Identity", label: "Payslips and receipts", kind: "file", required: true, multiple: true, allowedGroups: ["pdf", "image"] },
        { section: "Identity", label: "Private health statement", kind: "file", required: true, allowedGroups: ["pdf"] },
        { section: "Tax details", label: "ABN", kind: "text", required: true, validator: "au_abn_mod89" },
        { section: "Tax details", label: "Tax file number", kind: "text", required: true, validator: "au_tfn_mod11" },
        { section: "Sign-off", label: "Declaration", kind: "checkbox", required: true },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const { id: requestId, portalUrl } = (await created.json()) as { id: string; portalUrl: string };
  const portalPath = new URL(portalUrl).pathname;

  const errors = trackErrors(page);
  await page.goto(portalPath);

  // OTP gate
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(page.getByText("Harbour Advisory").first()).toBeVisible();
  await expectAccessible(page, testInfo, "otp-gate");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("6-digit verification code")).toBeVisible();
  const outbox = (await (await page.request.get("/api/outbox")).json()) as {
    emails: Array<{ recipient: string; kind: string; subject: string }>;
  };
  const otpMail = outbox.emails.find((e) => e.recipient === clientEmail && e.kind === "otp")!;
  const code = otpMail.subject.match(/^(\d{6})/)![1];
  await page.getByLabel("6-digit verification code").fill(code === "000000" ? "111111" : "000000");
  await expect(page.getByRole("alert")).toContainText(/Incorrect/);
  await page.getByLabel("6-digit verification code").fill(code);

  // Portal
  await expect(page.getByRole("heading", { name: "FY26 tax return" })).toBeVisible();
  await expect(page.getByText("0 of 5 done")).toBeVisible();
  const accent = await page.locator("header .bg-primary").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(accent).toBe("rgb(29, 78, 216)");
  await expectAccessible(page, testInfo, "portal");
  await screenshot(page, testInfo, "portal-start");

  const card = (label: string) => page.locator("article").filter({ has: page.getByRole("heading", { name: label, exact: true }) });

  // Multi-file upload with progress, then remove and re-add.
  const receipts = card("Payslips and receipts");
  await receipts.locator('input[type="file"]').first().setInputFiles([
    { name: "payslip-june.pdf", mimeType: "application/pdf", buffer: PDF },
    { name: "receipt.png", mimeType: "image/png", buffer: PNG },
  ]);
  await expect(receipts.getByText("payslip-june.pdf")).toBeVisible();
  await expect(receipts.getByText("receipt.png")).toBeVisible();
  await receipts.getByRole("button", { name: "Remove payslip-june.pdf" }).click();
  await expect(receipts.getByText("payslip-june.pdf")).toHaveCount(0);
  await expect(page.getByText("1 of 5 done")).toBeVisible();

  if (project === "mobile") {
    await expect(receipts.getByRole("button", { name: "Take a photo" })).toBeVisible();
  }

  // Not applicable with a reason.
  const health = card("Private health statement");
  await health.getByRole("button", { name: "This doesn't apply to me" }).click();
  await health.getByLabel("Why doesn't this apply to you?").fill("No private health cover this year");
  await health.getByRole("button", { name: "Mark as not applicable" }).click();
  await expect(health.getByText("Marked as not applicable.")).toBeVisible();

  // Checksum validation: bad ABN is caught, good one verifies.
  const abn = card("ABN").getByRole("textbox");
  await abn.fill("51 824 753 557");
  await abn.press("Enter");
  await expect(card("ABN").getByText(/Invalid ABN checksum/)).toBeVisible();
  await expect(abn).toHaveAttribute("aria-invalid", "true");
  await abn.fill("51 824 753 556");
  await abn.press("Enter");
  await expect(card("ABN").getByText("Verified and saved")).toBeVisible();

  const tfn = card("Tax file number").getByRole("textbox");
  await tfn.fill("876 543 210");
  await tfn.press("Enter");
  await expect(card("Tax file number").getByText("****** 210")).toBeVisible();
  await expect(tfn).toHaveValue("");

  // Note on an item that is already done.
  await receipts.getByRole("button", { name: "Add a note" }).click();
  await receipts.getByLabel("Note for Payslips and receipts").fill("June payslip coming from HR on Friday");
  await receipts.getByRole("button", { name: "Save note" }).click();
  await expect(receipts.getByText("June payslip coming from HR on Friday")).toBeVisible();

  await card("Declaration").getByRole("checkbox").click();

  await expect(page.getByRole("heading", { name: "All done, Claire" })).toBeVisible();
  await expect(page.getByText("5 of 5 done")).toBeVisible();
  await expect(page.getByRole("link", { name: "help@harbour.test" })).toBeVisible();
  await expectAccessible(page, testInfo, "portal-complete");
  await screenshot(page, testInfo, "portal-complete");

  if (project === "mobile") {
    await page.getByRole("button", { name: "Jump to an item" }).click();
    await expect(page.getByRole("dialog", { name: "Jump to an item" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Declaration" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  // Exactly two 400s are expected: the deliberate wrong OTP and the deliberate bad ABN.
  expect(errors.filter((e) => e.includes("status of 400"))).toHaveLength(2);
  expect(errors.filter((e) => !e.includes("status of 400"))).toEqual([]);

  // Operator sees the client's note and N/A reason.
  const detail = (await (await page.request.get(`/api/requests/${requestId}`)).json()) as {
    request: { status: string };
    items: Array<{ label: string; client_na: boolean; client_note: string | null }>;
  };
  expect(detail.request.status).toBe("in_review");
  expect(detail.items.find((i) => i.label === "Private health statement")).toMatchObject({
    client_na: true,
    client_note: "No private health cover this year",
  });
});
