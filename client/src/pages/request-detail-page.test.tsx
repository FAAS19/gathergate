import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RequestDetailResponse, SessionResponse } from "@/lib/api";
import { RequestDetailPage } from "@/pages/request-detail-page";

const SESSION: SessionResponse = {
  needsSetup: false,
  multiTenant: false,
  user: { id: "usr_1", email: "ops@harbour.test" },
  workspace: {
    id: "ws_1",
    name: "Harbour Advisory",
    slug: "harbour",
    plan: "self_hosted",
    max_active_requests: 0,
    max_storage_bytes: 0,
    webhook_url: null,
    has_webhook_secret: false,
    brand_color: null,
    has_logo: false,
    support_email: null,
    support_phone: null,
    created_at: "2026-11-22T00:00:00.000Z",
  },
  readiness: {
    storageBackend: "local",
    emailBackend: "console",
    cronIntervalMinutes: 5,
    defaultPurgeDays: 30,
    hasDemoData: false,
    outboxCount: 0,
  },
};

function makeDetail(): RequestDetailResponse {
  return {
    request: {
      id: "req_1",
      title: "FY26 Tax Pack",
      client_name: "Maya Patel",
      client_email: "maya@client.test",
      client_subject: null,
      welcome_note: null,
      status: "in_review",
      require_otp: false,
      reminders_sent: 0,
      max_reminders: 4,
      reminders_paused: false,
      next_reminder_at: null,
      purge_after_days: 30,
      purge_at: null,
      due_at: null,
      last_opened_at: null,
      last_manual_reminder_at: null,
      completed_at: null,
      is_demo: false,
      created_at: "2026-11-22T00:00:00.000Z",
    },
    portalUrl: "http://localhost:3080/c/tok_1",
    items: [
      {
        id: "itm_1",
        position: 0,
        section: "Documents",
        label: "Bank Statement",
        help_text: "",
        kind: "file",
        required: true,
        validator: "none",
        config: {},
        status: "submitted",
        displayValue: null,
        isSensitiveMasked: false,
        review_note: null,
        client_note: null,
        client_na: false,
        updated_at: "2026-11-22T00:00:00.000Z",
        uploads: [
          {
            id: "upl_1",
            original_name: "statement.pdf",
            canonical_name: "maya_statement_01.pdf",
            detected_mime: "application/pdf",
            size_bytes: 2048,
            created_at: "2026-11-22T00:00:00.000Z",
          },
        ],
      },
      {
        id: "itm_2",
        position: 1,
        section: "Documents",
        label: "Tax Receipt",
        help_text: "",
        kind: "file",
        required: true,
        validator: "none",
        config: {},
        status: "submitted",
        displayValue: null,
        isSensitiveMasked: false,
        review_note: null,
        client_note: null,
        client_na: false,
        updated_at: "2026-11-22T00:00:00.000Z",
        uploads: [
          {
            id: "upl_2",
            original_name: "receipt.png",
            canonical_name: "maya_receipt_01.png",
            detected_mime: "image/png",
            size_bytes: 1024,
            created_at: "2026-11-22T00:00:00.000Z",
          },
        ],
      },
    ],
    auditEvents: [],
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/requests/req_1"]}>
        <Routes>
          <Route
            path="/requests/:id"
            element={
              <RequestDetailPage
                session={SESSION}
                onSessionRefresh={vi.fn().mockResolvedValue(undefined)}
                theme="light"
                onToggleTheme={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </TooltipProvider>
  );
}

describe("RequestDetailPage", () => {
  it("supports keyboard triage (J/K/Space/A/R/?) and continuous document preview", async () => {
    const user = userEvent.setup();
    let detailState = makeDetail();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/requests/req_1") {
        return jsonResponse(200, detailState);
      }
      if (url === "/api/uploads/upl_1/preview") {
        return new Response(new Blob(["%PDF-1.4"], { type: "application/pdf" }), { status: 200 });
      }
      if (url === "/api/uploads/upl_2/preview") {
        return new Response(new Blob(["png"], { type: "image/png" }), { status: 200 });
      }
      if (url === "/api/requests/req_1/items/itm_1/review") {
        const body = JSON.parse(String(init?.body || "{}")) as { decision: "approved" | "rejected" };
        detailState = {
          ...detailState,
          items: detailState.items.map((i) => (i.id === "itm_1" ? { ...i, status: body.decision } : i)),
        };
        return jsonResponse(200, { ok: true, justCompleted: false });
      }
      return jsonResponse(404, { error: "Not mocked" });
    });

    const { container } = renderPage();
    await screen.findByText("Bank Statement");

    const card1 = () => container.querySelector('[data-item-id="itm_1"]')!;
    const card2 = () => container.querySelector('[data-item-id="itm_2"]')!;

    await user.keyboard("j");
    expect(card1()).toHaveAttribute("data-selected", "true");

    await user.keyboard("j");
    expect(card2()).toHaveAttribute("data-selected", "true");
    expect(card1()).not.toHaveAttribute("data-selected");

    await user.keyboard("k");
    expect(card1()).toHaveAttribute("data-selected", "true");

    // Space opens continuous preview drawer
    await user.keyboard(" ");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    expect(screen.getAllByText("maya_statement_01.pdf").length).toBeGreaterThanOrEqual(1);

    // Keyboard J/K steps inside open ReviewSheet
    await user.keyboard("j");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("125%");
    expect(screen.getByAltText("maya_receipt_01.png")).toHaveAttribute("data-zoom", "125");
    await user.keyboard("k");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    await user.keyboard("j");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();

    // Esc closes preview sheet
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("2 of 2")).not.toBeInTheDocument());

    // ? toggles shortcut cheat-sheet
    await user.keyboard("?");
    expect(await screen.findByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument()
    );

    // A approves active item (itm_1)
    await user.keyboard("a");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/requests/req_1/items/itm_1/review",
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(card1()).toHaveTextContent("Locked");

    // R opens revision dialog on second item and typing inside textarea does not trigger triage keys
    await user.keyboard("j");
    await user.keyboard("r");
    const noteBox = await screen.findByLabelText("Client-facing note");
    await user.type(noteBox, "ja?");
    expect(noteBox).toHaveValue("ja?");
    expect(card2()).toHaveAttribute("data-selected", "true");
    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("rolls back optimistic approve and reminder toggle on 500 error", async () => {
    const user = userEvent.setup();
    let resolveReview!: (res: Response) => void;
    let resolveToggle!: (res: Response) => void;

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/requests/req_1") {
        return Promise.resolve(jsonResponse(200, makeDetail()));
      }
      if (url === "/api/requests/req_1/items/itm_1/review") {
        return new Promise<Response>((resolve) => {
          resolveReview = resolve;
        });
      }
      if (url === "/api/requests/req_1/toggle-reminders") {
        return new Promise<Response>((resolve) => {
          resolveToggle = resolve;
        });
      }
      return Promise.resolve(jsonResponse(404, { error: "Not mocked" }));
    });

    const { container } = renderPage();
    await screen.findByText("Bank Statement");

    const card1 = container.querySelector('[data-item-id="itm_1"]') as HTMLElement;
    const approveBtn = within(card1).getByRole("button", { name: "Approve & lock" });
    expect(card1).toHaveTextContent("Submitted");

    await user.click(approveBtn);
    // Immediately optimistic: item shows Locked before server responds
    expect(card1).toHaveTextContent("Locked");

    await act(async () => {
      resolveReview(jsonResponse(500, { error: "Database locked" }));
    });

    await waitFor(() => expect(card1).toHaveTextContent("Submitted"));
    expect(await screen.findByText("Database locked")).toBeInTheDocument();

    // Pause chaser optimistic rollback
    const chaserBtn = screen.getByRole("button", { name: "Pause chaser" });
    await user.click(chaserBtn);
    expect(screen.getByRole("button", { name: "Resume chaser" })).toBeInTheDocument();

    await act(async () => {
      resolveToggle(jsonResponse(500, { error: "Chaser error" }));
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause chaser" })).toBeInTheDocument()
    );
    expect(await screen.findByText("Chaser error")).toBeInTheDocument();
  });
});
