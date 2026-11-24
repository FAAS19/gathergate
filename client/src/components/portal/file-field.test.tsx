import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileField } from "@/components/portal/file-field";
import type { RequestItemDto } from "@/lib/api";

class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  status = 0;
  responseText = "";
  withCredentials = false;
  url = "";
  body: FormData | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXHR.last = this;
  }
  respond(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}

function makeItem(overrides: Partial<RequestItemDto> = {}): RequestItemDto {
  return {
    id: "itm_1",
    position: 0,
    section: "Docs",
    label: "Bank statement",
    help_text: "",
    kind: "file",
    required: true,
    validator: "none",
    config: { allowedGroups: ["pdf"], maxFileMb: 1 },
    status: "pending",
    isSensitiveMasked: false,
    review_note: null,
    updated_at: "",
    uploads: [],
    ...overrides,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("FileField", () => {
  it("shows real upload progress, then refreshes the checklist", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<FileField item={makeItem()} token="tok" locked={false} onChanged={onChanged} />);

    const file = new File(["%PDF-1.4"], "march.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByTestId("file-input-itm_1"), file);
    await waitFor(() => expect(FakeXHR.last).not.toBeNull());
    expect(FakeXHR.last!.url).toBe("/api/client/tok/items/itm_1");

    act(() => FakeXHR.last!.upload.onprogress!({ lengthComputable: true, loaded: 40, total: 100 }));
    expect(screen.getByRole("progressbar", { name: /Uploading march.pdf/ })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();

    await act(async () => FakeXHR.last!.respond(200, { uploads: [{ id: "upl_1" }] }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("rejects files over the size limit before uploading", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    FakeXHR.last = null;
    render(<FileField item={makeItem()} token="tok" locked={false} onChanged={vi.fn()} />);
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "huge.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByTestId("file-input-itm_1"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent('"huge.pdf" is larger than 1 MB.');
    expect(FakeXHR.last).toBeNull();
    vi.unstubAllGlobals();
  });

  it("surfaces server rejection messages", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    render(<FileField item={makeItem()} token="tok" locked={false} onChanged={vi.fn()} />);
    await userEvent.upload(
      screen.getByTestId("file-input-itm_1"),
      new File(["MZ"], "invoice.pdf", { type: "application/pdf" })
    );
    await waitFor(() => expect(FakeXHR.last).not.toBeNull());
    await act(async () => FakeXHR.last!.respond(400, { error: '"invoice.pdf" failed file-type verification.' }));
    expect(await screen.findByRole("alert")).toHaveTextContent("failed file-type verification");
    vi.unstubAllGlobals();
  });

  it("removes an uploaded file and hides controls once locked", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, { ok: true }));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const uploads = [
      { id: "upl_9", original_name: "march.pdf", canonical_name: "x.pdf", detected_mime: "application/pdf", size_bytes: 2048, created_at: "" },
    ];
    const { rerender } = render(
      <FileField item={makeItem({ status: "submitted", uploads })} token="tok" locked={false} onChanged={onChanged} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove march.pdf" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/client/tok/uploads/upl_9", expect.objectContaining({ method: "DELETE" }));

    rerender(<FileField item={makeItem({ status: "approved", uploads })} token="tok" locked onChanged={onChanged} />);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replace/ })).not.toBeInTheDocument();
  });
});
