import { useEffect, useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { apiJson, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export function OtpGate({
  token,
  maskedEmail,
  title,
  onVerified,
}: {
  token: string;
  maskedEmail: string;
  title: string;
  onVerified: () => Promise<void>;
}) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await apiJson(`/api/client/${token}/otp/send`, { method: "POST" });
      setSent(true);
      setCooldown(30);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code. Try again.");
    } finally {
      setSending(false);
    }
  }

  async function verify(value: string) {
    if (value.length !== 6) return;
    setVerifying(true);
    setError(null);
    try {
      await apiJson(`/api/client/${token}/otp/verify`, { method: "POST", body: JSON.stringify({ code: value }) });
      await onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That code didn't work.");
      setCode("");
      setShakeKey((k) => k + 1);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="w-full max-w-[400px] rounded-xl border border-border bg-card p-8 shadow-[0_1px_2px_rgba(17,24,28,0.04)]">
      <h1 className="text-xl font-semibold tracking-tight">Confirm it's you</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {sent ? (
          <>
            We sent a 6-digit code to <span className="font-medium text-foreground">{maskedEmail}</span>.
          </>
        ) : (
          <>
            To protect <span className="font-medium text-foreground">{title}</span>, we'll email a code to{" "}
            <span className="font-medium text-foreground">{maskedEmail}</span>.
          </>
        )}
      </p>

      {!sent ? (
        <Button type="button" className="mt-6 h-10 w-full" onClick={send} disabled={sending}>
          {sending && <Loader2 className="size-4 animate-spin" />}
          Email me a code
        </Button>
      ) : (
        <div className="mt-6 space-y-4">
          <div key={shakeKey} className={cn("flex justify-center", shakeKey > 0 && "animate-shake")}>
            <InputOTP
              autoFocus
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              value={code}
              disabled={verifying}
              aria-label="6-digit verification code"
              onChange={(v) => {
                setCode(v);
                if (v.length === 6) void verify(v);
              }}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} className="size-11 font-mono text-lg" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          <p className="min-h-5 text-center text-sm" aria-live="polite">
            {verifying ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Checking
              </span>
            ) : error ? (
              <span className="font-medium text-destructive" role="alert">
                {error}
              </span>
            ) : null}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Didn't get it?{" "}
            <button
              type="button"
              onClick={send}
              disabled={cooldown > 0 || sending}
              className="font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </p>
        </div>
      )}

      {!sent && error && (
        <p className="mt-3 text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
