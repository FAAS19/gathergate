import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type ClientPortalResponse,
  type OutboxEmailDto,
  type RequestDetailResponse,
  type RequestsListResponse,
} from "./api";
import {
  demoApiBlob,
  demoApiJson,
  demoApiUpload,
  demoDownloadExport,
  demoDownloadUpload,
  resetDemoState,
} from "./demo-api";
import { maskSensitiveValue, validateTextValue } from "./demo-validators";

describe("demo-validators & demo-api", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("validates ABN mod-89 (valid, invalid) and fails closed on unknown validators", async () => {
    expect(validateTextValue("au_abn_mod89", "51824753556")).toEqual({
      valid: true,
      normalised: "51 824 753 556",
    });
    expect(validateTextValue("au_abn_mod89", "51824753557")).toEqual({
      valid: false,
      error: "Invalid ABN checksum (ATO mod-89 failed)",
    });
    expect(validateTextValue("unknown_key", "abc")).toEqual({
      valid: false,
      error: "This field has an unknown validator. Contact the sender.",
    });

    const portal = await demoApiJson<ClientPortalResponse>("/api/client/demo-bas");
    const abnItem = portal.items!.find((i) => i.validator === "au_abn_mod89")!;
    expect(abnItem.status).toBe("pending");

    await expect(
      demoApiJson(`/api/client/demo-bas/items/${abnItem.id}`, {
        method: "POST",
        body: JSON.stringify({ value: "51824753557" }),
      })
    ).rejects.toMatchObject({ status: 400 });

    const saved = await demoApiJson<{ ok: boolean; item: { currentValue: string } }>(
      `/api/client/demo-bas/items/${abnItem.id}`,
      {
        method: "POST",
        body: JSON.stringify({ value: "51824753556" }),
      }
    );
    expect(saved.ok).toBe(true);
    expect(saved.item.currentValue).toBe("51 824 753 556");
  });

  it("masks TFN values and reveals unmasked value with audit logging", async () => {
    expect(maskSensitiveValue("au_tfn_mod11", "876 543 210")).toBe("****** 210");

    const detail = await demoApiJson<RequestDetailResponse>("/api/requests/req_demo_tax");
    const tfnItem = detail.items.find((i) => i.validator === "au_tfn_mod11")!;
    expect(tfnItem.isSensitiveMasked).toBe(true);
    expect(tfnItem.displayValue).toBe("****** 210");

    const revealed = await demoApiJson<{ itemId: string; value: string }>(
      `/api/requests/req_demo_tax/items/${tfnItem.id}/reveal`,
      { method: "POST" }
    );
    expect(revealed).toEqual({ itemId: tfnItem.id, value: "876 543 210" });

    const updatedDetail = await demoApiJson<RequestDetailResponse>("/api/requests/req_demo_tax");
    expect(updatedDetail.auditEvents[0].action).toBe("item.sensitive_revealed");
  });

  it("gates demo-tax behind OTP send, rejects wrong code, and unlocks on 482910", async () => {
    const locked = await demoApiJson<ClientPortalResponse>("/api/client/demo-tax");
    expect(locked.requiresOtp).toBe(true);
    expect(locked.items).toBeUndefined();

    const sent = await demoApiJson<{ ok: boolean; maskedEmail: string }>(
      "/api/client/demo-tax/otp/send",
      { method: "POST" }
    );
    expect(sent.ok).toBe(true);

    const outbox = await demoApiJson<{ emails: OutboxEmailDto[] }>("/api/outbox");
    expect(outbox.emails[0].kind).toBe("otp");
    expect(outbox.emails[0].subject).toContain("482910");

    await expect(
      demoApiJson("/api/client/demo-tax/otp/verify", {
        method: "POST",
        body: JSON.stringify({ code: "000000" }),
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof ApiError && err.status === 400);

    const verified = await demoApiJson<{ ok: boolean }>("/api/client/demo-tax/otp/verify", {
      method: "POST",
      body: JSON.stringify({ code: "482910" }),
    });
    expect(verified.ok).toBe(true);

    const unlocked = await demoApiJson<ClientPortalResponse>("/api/client/demo-tax");
    expect(unlocked.requiresOtp).toBe(false);
    expect(unlocked.items?.length).toBe(6);
  });

  it("supports file upload, rejects spoofed binaries, and retrieves blobs for preview", async () => {
    const portal = await demoApiJson<ClientPortalResponse>("/api/client/demo-bas");
    const invoiceItem = portal.items!.find((i) => i.config.slug === "supplier-invoices")!;

    const badFd = new FormData();
    badFd.append("file", new File(["MZexecutable"], "bad.pdf", { type: "application/pdf" }));
    await expect(
      demoApiUpload(`/api/client/demo-bas/items/${invoiceItem.id}`, badFd)
    ).rejects.toMatchObject({ status: 400 });

    const pdfContent = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF";
    const goodFd = new FormData();
    goodFd.append("file", new File([pdfContent], "supplier-inv.pdf", { type: "application/pdf" }));
    const uploaded = await demoApiUpload<{
      ok: boolean;
      uploads: Array<{ id: string; canonical_name: string; detected_mime: string }>;
    }>(`/api/client/demo-bas/items/${invoiceItem.id}`, goodFd);

    expect(uploaded.ok).toBe(true);
    expect(uploaded.uploads).toHaveLength(1);
    expect(uploaded.uploads[0].canonical_name).toBe(
      "harbourline-plumbing-pty-ltd_supplier-invoices_01.pdf"
    );

    const blob = await demoApiBlob(`/api/uploads/${uploaded.uploads[0].id}/preview`);
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe(pdfContent);

    const seededCsv = await demoApiBlob("/api/uploads/upl_demo_tax_receipts/preview");
    expect(seededCsv.type).toBe("text/csv");
    expect(await seededCsv.text()).toContain("CPA Australia");
  });

  it("handles operator approve, reject, status transitions, portal_url, and browser downloads", async () => {
    const list = await demoApiJson<RequestsListResponse>("/api/requests");
    expect(list.requests.find((r) => r.id === "req_demo_bas")?.portal_url).toContain("#/c/demo-bas");
    expect(list.requests.find((r) => r.id === "req_demo_tax")?.portal_url).toContain("#/c/demo-tax");

    const portal = await demoApiJson<ClientPortalResponse>("/api/client/demo-bas");
    const abnItem = portal.items!.find((i) => i.validator === "au_abn_mod89")!;
    const authItem = portal.items!.find((i) => i.kind === "checkbox")!;

    await demoApiJson(`/api/client/demo-bas/items/${abnItem.id}`, {
      method: "POST",
      body: JSON.stringify({ value: "51824753556" }),
    });
    const afterDecl = await demoApiJson<{ requestStatus: string }>(
      `/api/client/demo-bas/items/${authItem.id}`,
      {
        method: "POST",
        body: JSON.stringify({ checked: true }),
      }
    );
    expect(afterDecl.requestStatus).toBe("in_review");

    const batch = await demoApiJson<{ approvedCount: number; status: string; justCompleted: boolean }>(
      "/api/requests/req_demo_bas/approve-all-submitted",
      { method: "POST" }
    );
    expect(batch.approvedCount).toBe(4);
    expect(batch.status).toBe("completed");
    expect(batch.justCompleted).toBe(true);

    const rejected = await demoApiJson<{ status: string }>(
      `/api/requests/req_demo_bas/items/${abnItem.id}/review`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", note: "Mismatch with ASIC record" }),
      }
    );
    expect(rejected.status).toBe("open");

    const outbox = await demoApiJson<{ emails: OutboxEmailDto[] }>("/api/outbox");
    expect(outbox.emails[0].kind).toBe("revision");
    expect(outbox.emails[0].text_body).toContain("Mismatch with ASIC record");

    vi.useFakeTimers();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    demoDownloadUpload("upl_demo_bas_bank");
    demoDownloadExport("req_demo_health");
    expect(clickSpy).toHaveBeenCalledTimes(2);
    vi.runAllTimers();
    expect(revokeSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("resets all in-memory state cleanly on resetDemoState()", async () => {
    await demoApiJson("/api/client/demo-tax/otp/verify", {
      method: "POST",
      body: JSON.stringify({ code: "482910" }),
    });
    await demoApiJson("/api/demo/clear", { method: "POST" });
    const cleared = await demoApiJson<RequestsListResponse>("/api/requests");
    expect(cleared.requests).toHaveLength(0);

    resetDemoState();

    const restored = await demoApiJson<RequestsListResponse>("/api/requests");
    expect(restored.requests).toHaveLength(3);
    const taxPortal = await demoApiJson<ClientPortalResponse>("/api/client/demo-tax");
    expect(taxPortal.requiresOtp).toBe(true);
  });

  it("exposes 6 templates, 16 validators, localStorage persistence, checkbox rejection reset, and export notes", async () => {
    const tplRes = await demoApiJson<{ templates: Array<{ id: string; name: string }> }>("/api/templates");
    expect(tplRes.templates).toHaveLength(6);
    expect(tplRes.templates.some((t) => t.id === "tpl_kyc")).toBe(true);
    expect(tplRes.templates.some((t) => t.id === "tpl_mortgage")).toBe(true);

    const valRes = await demoApiJson<{ validators: Array<{ key: string }> }>("/api/validators");
    expect(valRes.validators).toHaveLength(16);

    const created = await demoApiJson<{ id: string }>("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        templateId: "tpl_kyc",
        title: "Persisted KYC Pack",
        clientName: "Alice Tester",
        clientEmail: "alice@example.com.au",
      }),
    });
    const stored = window.localStorage.getItem("gathergate-demo-state-v1");
    expect(stored).toContain(created.id);
    expect(stored).toContain("Persisted KYC Pack");

    const portal = await demoApiJson<ClientPortalResponse>("/api/client/demo-bas");
    const authItem = portal.items!.find((i) => i.kind === "checkbox")!;
    await demoApiJson(`/api/client/demo-bas/items/${authItem.id}`, {
      method: "POST",
      body: JSON.stringify({ checked: true }),
    });
    await demoApiJson(`/api/requests/req_demo_bas/items/${authItem.id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "rejected", note: "Sign updated mandate" }),
    });
    const afterReject = await demoApiJson<ClientPortalResponse>("/api/client/demo-bas");
    const rejectedCheckbox = afterReject.items!.find((i) => i.id === authItem.id)!;
    expect(rejectedCheckbox.status).toBe("rejected");
    expect(rejectedCheckbox.currentValue).toBeNull();

    const reconfirmed = await demoApiJson<{ item: { status: string; currentValue: string } }>(
      `/api/client/demo-bas/items/${authItem.id}`,
      {
        method: "POST",
        body: JSON.stringify({ checked: true }),
      }
    );
    expect(reconfirmed.item.status).toBe("submitted");
    expect(reconfirmed.item.currentValue).toBe("confirmed");

    await demoApiJson(`/api/client/demo-bas/items/${authItem.id}/note`, {
      method: "PUT",
      body: JSON.stringify({ na: false, note: "Confirmed after AGM" }),
    });
    let exportedBlob: Blob | null = null;
    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
      if (obj instanceof Blob) exportedBlob = obj;
      return "blob:demo-export";
    });
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      demoDownloadExport("req_demo_bas");
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
    expect(exportedBlob).not.toBeNull();
    const manifest = JSON.parse(await exportedBlob!.text()) as {
      items: Array<{ client_na: boolean; client_note: string | null }>;
    };
    expect(manifest.items.some((i) => i.client_note === "Confirmed after AGM")).toBe(true);
    expect(manifest.items.every((i) => typeof i.client_na === "boolean")).toBe(true);
  });
});
