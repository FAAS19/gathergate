import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OtpGate } from "@/components/portal/otp-gate";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("OtpGate", () => {
  it("sends a code, rejects a wrong one, then verifies", async () => {
    const responses = [
      json(200, { ok: true, maskedEmail: "cl***@client.test" }),
      json(400, { error: "Incorrect 6-digit code." }),
      json(200, { ok: true }),
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift()!);
    const onVerified = vi.fn().mockResolvedValue(undefined);
    render(<OtpGate token="tok" maskedEmail="cl***@client.test" title="FY26 pack" onVerified={onVerified} />);

    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    const input = await screen.findByLabelText("6-digit verification code");
    expect(screen.getByText(/We sent a 6-digit code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resend in \d+s/ })).toBeDisabled();

    await userEvent.type(input, "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect 6-digit code.");
    expect(onVerified).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("6-digit verification code"), "123456");
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/client/tok/otp/send",
      "/api/client/tok/otp/verify",
      "/api/client/tok/otp/verify",
    ]);
  });
});
