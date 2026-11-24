import zlib from "node:zlib";
import { expect, test } from "@playwright/test";
import { expectAccessible, PNG, screenshot, trackErrors } from "./helpers";

function parseZipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: EOCD not found");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory signature mismatch");
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("operator creates, customises, reviews via continuous preview, verifies ZIP export and bulk pauses", async ({
  page,
}, testInfo) => {
  const errors = trackErrors(page);

  // 1. Templates: duplicate a starter pack, verify white-label preview in builder, clean up copy
  await page.goto("/templates");
  const basCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("AU Company / BAS Bookkeeping Pack", { exact: true }) })
    .first();
  await basCard.getByRole("button", { name: "Duplicate" }).click();

  const copyCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("AU Company / BAS Bookkeeping Pack (Copy)", { exact: true }) })
    .first();
  await expect(copyCard).toBeVisible();
  await copyCard.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Live Client Portal Preview")).toBeVisible();
  await expect(page.getByText("Harbour Advisory").last()).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Delete AU Company / BAS Bookkeeping Pack (Copy)" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(copyCard).toHaveCount(0);

  // 2. Create request from template
  await page.goto("/requests/new");
  await page.getByRole("button", { name: /AU Company \/ BAS Bookkeeping Pack/ }).click();
  await expect(page.getByText("Included items (5 of 5)")).toBeVisible();

  for (const label of [
    "Australian Business Number (ABN)",
    "Operating Bank BSB",
    "Missing Supplier Tax Invoices & Capital Purchases",
    "Director BAS Lodgement Authority",
  ]) {
    await page.getByLabel(label).uncheck();
  }
  await expect(page.getByText("Included items (1 of 5)")).toBeVisible();

  await page.getByLabel("Client name").fill("Maya Patel");
  await page.getByLabel("Client email", { exact: true }).fill("maya+m2@client.test");
  await page.getByLabel("Internal checklist title").fill("FY26 Operator Review Pack");
  const otpSwitch = page.locator("#requireOtp");
  if (await otpSwitch.isChecked()) await otpSwitch.click();

  await page.getByRole("button", { name: "Create & send magic link" }).click();
  await expect(page).toHaveURL(/\/requests\/req_/);
  const requestId = new URL(page.url()).pathname.split("/requests/")[1];

  // 3. Live request controls: edit due date, add required item, send manual reminder
  await page.getByRole("button", { name: "Set due date" }).click();
  await page.getByLabel("Target due date").fill("2026-12-20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Due 2026-12-20" })).toBeVisible();

  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Item label").fill("Supplier Invoice Photo");
  await page.getByRole("button", { name: "Add to checklist" }).click();
  await expect(page.getByText("Supplier Invoice Photo")).toBeVisible();

  await page.getByRole("button", { name: "Send reminder now" }).click();
  await expect(page.getByRole("button", { name: "Reminder sent recently" })).toBeDisabled();

  await page.getByRole("tab", { name: /Audit Timeline/ }).click();
  await expect(page.getByText("Operator sent manual reminder")).toBeVisible();
  await expect(page.getByText("Operator updated due date")).toBeVisible();
  await expect(page.getByText("Operator added checklist item")).toBeVisible();
  await page.getByRole("tab", { name: /Checklist Items/ }).click();

  // 4. Client uploads files to both items via API
  const detailRes = await page.request.get(`/api/requests/${requestId}`);
  const detail = (await detailRes.json()) as {
    portalUrl: string;
    items: Array<{ id: string; label: string }>;
  };
  const portalPath = new URL(detail.portalUrl).pathname;
  const token = portalPath.split("/c/")[1];
  const stmtItem = detail.items.find((i) => i.label.includes("Business Bank Statements"))!;
  const photoItem = detail.items.find((i) => i.label === "Supplier Invoice Photo")!;

  const uniquePdf = Buffer.from("%PDF-1.4\n% UNIQUE_STATEMENT_BYTES\n%%EOF\n");
  const up1 = await page.request.post(`/api/client/${token}/items/${stmtItem.id}`, {
    multipart: {
      file: { name: "statement.pdf", mimeType: "application/pdf", buffer: uniquePdf },
    },
  });
  expect(up1.status()).toBe(200);

  const up2 = await page.request.post(`/api/client/${token}/items/${photoItem.id}`, {
    multipart: {
      file: { name: "invoice.png", mimeType: "image/png", buffer: PNG },
    },
  });
  expect(up2.status()).toBe(200);

  // 5. Continuous document review via keyboard + Zoom + Approve & next + reject
  await page.reload();
  await expect(page.getByText("maya-patel_bank-statements_01.pdf")).toBeVisible();
  await expect(page.getByText("maya-patel_supplier-invoice-photo_01.png")).toBeVisible();

  await page.getByRole("heading", { name: "FY26 Operator Review Pack" }).click();
  await page.keyboard.press("j");
  await expect(page.locator(`[data-item-id="${stmtItem.id}"]`)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press(" ");

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("1 of 2")).toBeVisible();
  await sheet.getByRole("button", { name: "Zoom in" }).click();
  await expect(sheet.getByRole("button", { name: "Reset zoom" })).toHaveText("125%");
  await screenshot(page, testInfo, "operator-review-sheet");

  await sheet.getByRole("button", { name: "Approve & next" }).click();
  await expect(sheet.getByText("2 of 2")).toBeVisible();

  await sheet.getByRole("button", { name: "Request revision" }).click();
  const modal = page.getByRole("dialog", { name: "Request revision" });
  await modal.getByRole("button", { name: "Blurry or unreadable scan" }).click();
  await modal.getByRole("button", { name: "Send revision request" }).click();
  await expect(page.locator(`[data-item-id="${photoItem.id}"]`).getByText("Revision needed")).toBeVisible();

  // 6. Client re-uploads fixed invoice on portal
  await page.goto(portalPath);
  await expect(page.getByText("1 item needs an update")).toBeVisible();
  await expect(page.getByText("Blurry or unreadable scan")).toBeVisible();
  const photoCard = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Supplier Invoice Photo", exact: true }) });
  await photoCard.getByRole("button", { name: "Remove invoice.png" }).click();
  await expect(photoCard.getByText("invoice.png")).toHaveCount(0);

  const fixedPdf = Buffer.from("%PDF-1.4\n% FIXED_INVOICE_BYTES\n%%EOF\n");
  await photoCard.locator('input[type="file"]').first().setInputFiles({
    name: "fixed-invoice.pdf",
    mimeType: "application/pdf",
    buffer: fixedPdf,
  });
  await expect(photoCard.getByText("fixed-invoice.pdf")).toBeVisible();

  // 7. Operator approves replacement and verifies decrypted ZIP contents
  await page.goto(`/requests/${requestId}`);
  const opPhotoCard = page.locator(`[data-item-id="${photoItem.id}"]`);
  await expect(opPhotoCard.getByText("Submitted")).toBeVisible();
  await opPhotoCard.getByRole("button", { name: "Approve & lock" }).click();
  await expect(page.getByText("Completed").first()).toBeVisible();

  const zipRes = await page.request.get(`/api/requests/${requestId}/export.zip`);
  expect(zipRes.status()).toBe(200);
  const entries = parseZipEntries(await zipRes.body());
  const summary = JSON.parse(entries.get("summary.json")!.toString("utf8")) as {
    status: string;
    items: Array<{ label: string; status: string }>;
  };
  expect(summary.status).toBe("completed");
  expect(summary.items.every((i) => i.status === "approved")).toBe(true);
  expect(entries.get("files/maya-patel_bank-statements_01.pdf")?.toString("utf8")).toContain(
    "UNIQUE_STATEMENT_BYTES"
  );
  expect(entries.get("files/maya-patel_supplier-invoice-photo_01.pdf")?.toString("utf8")).toContain(
    "FIXED_INVOICE_BYTES"
  );

  // 8. Dashboard bulk pause & resume
  const bulkCreate = await page.request.post("/api/requests", {
    data: {
      title: "Bulk Pause Test Pack",
      clientName: "Liam Park",
      clientEmail: "liam+m2@client.test",
      sendInvite: false,
      items: [{ label: "ID Document", kind: "file", required: true }],
    },
  });
  expect(bulkCreate.status()).toBe(201);

  await page.goto("/");
  await page.getByRole("checkbox", { name: "Select Bulk Pause Test Pack" }).click();
  await page.getByRole("button", { name: "Pause reminders" }).click();
  const bulkRow = page.locator("tr").filter({ hasText: "Bulk Pause Test Pack" });
  await expect(bulkRow.getByText("Paused")).toBeVisible();

  await page.reload();
  await expect(page.locator("tr").filter({ hasText: "Bulk Pause Test Pack" }).getByText("Paused")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Bulk Pause Test Pack" }).click();
  await page.getByRole("button", { name: "Resume reminders" }).click();
  await expect(page.locator("tr").filter({ hasText: "Bulk Pause Test Pack" }).getByText("Paused")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("all 5 operator routes pass WCAG 2.2 AA in Light and Dark themes", async ({ page }, testInfo) => {
  const errors = trackErrors(page);

  const listRes = await page.request.get("/api/requests");
  const list = (await listRes.json()) as { requests: Array<{ id: string }> };
  const sampleId = list.requests[0].id;

  const auditRoutes = async (themeLabel: "light" | "dark") => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Intake Requests" })).toBeVisible();
    await expectAccessible(page, testInfo, `dashboard-${themeLabel}`);

    await page.goto(`/requests/${sampleId}`);
    await expect(page.getByText("Checklist Items")).toBeVisible();
    await expectAccessible(page, testInfo, `request-detail-${themeLabel}`);

    await page.goto("/requests/new");
    await expect(page.getByRole("heading", { name: "New Checklist Request" })).toBeVisible();
    await expectAccessible(page, testInfo, `new-request-${themeLabel}`);

    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Checklist Templates" })).toBeVisible();
    await expectAccessible(page, testInfo, `templates-list-${themeLabel}`);
    await page.getByRole("button", { name: "New checklist template" }).click();
    await expect(page.getByText("Live Client Portal Preview")).toBeVisible();
    await expectAccessible(page, testInfo, `templates-builder-${themeLabel}`);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expectAccessible(page, testInfo, `settings-${themeLabel}`);
  };

  try {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("gathergate-theme", "light"));
    await page.reload();
    await auditRoutes("light");

    await page.goto("/");
    await page.getByRole("button", { name: /Harbour Advisory/ }).click();
    await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await screenshot(page, testInfo, "dashboard-dark");
    await auditRoutes("dark");
  } finally {
    await page.evaluate(() => {
      window.localStorage.setItem("gathergate-theme", "light");
      document.documentElement.classList.remove("dark");
    });
  }

  expect(errors).toEqual([]);
});
