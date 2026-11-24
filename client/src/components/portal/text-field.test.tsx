import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextField } from "@/components/portal/text-field";
import type { RequestItemDto } from "@/lib/api";

const abnItem: RequestItemDto = {
  id: "itm_abn",
  position: 0,
  section: "Business",
  label: "ABN",
  help_text: "",
  kind: "text",
  required: true,
  validator: "au_abn_mod89",
  validator_hint: "51 824 753 556",
  config: {},
  status: "pending",
  isSensitiveMasked: false,
  review_note: null,
  updated_at: "",
  uploads: [],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("TextField", () => {
  it("shows the format example and opens a number pad for identifiers", () => {
    render(<TextField item={abnItem} token="tok" locked={false} onChanged={vi.fn()} />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("placeholder", "51 824 753 556");
  });

  it("clears a sensitive identifier from the field once it is stored masked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(200, { ok: true, item: { status: "submitted", currentValue: "****** 210", isSensitiveMasked: true } })
    );
    render(
      <TextField item={{ ...abnItem, validator: "au_tfn_mod11" }} token="tok" locked={false} onChanged={vi.fn().mockResolvedValue(undefined)} />
    );
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "876543210{Enter}");
    expect(await screen.findByText("Verified and saved")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows the server checksum error inline and marks the field invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(400, { error: "Invalid ABN checksum (ATO mod-89 failed)" })
    );
    render(<TextField item={abnItem} token="tok" locked={false} onChanged={vi.fn()} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "51824753557");
    await userEvent.tab();
    expect(await screen.findByText("Invalid ABN checksum (ATO mod-89 failed)")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("saves on Enter and confirms verification", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, { ok: true }));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<TextField item={abnItem} token="tok" locked={false} onChanged={onChanged} />);
    await userEvent.type(screen.getByRole("textbox"), "51824753556{Enter}");
    expect(await screen.findByText("Verified and saved")).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/client/tok/items/itm_abn");
    expect(JSON.parse(String(init?.body))).toEqual({ value: "51824753556" });
  });

  it("never pre-fills masked sensitive values", () => {
    render(
      <TextField
        item={{ ...abnItem, validator: "au_tfn_mod11", isSensitiveMasked: true, currentValue: "****** 210", status: "submitted" }}
        token="tok"
        locked={false}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByText("****** 210")).toBeInTheDocument();
  });
});
