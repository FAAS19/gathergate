import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle, CircleNotch, EnvelopeSimple, PaperPlaneTilt, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiJson, ApiError, type EmailSettingsDto } from "@/lib/api";
import { cn } from "@/lib/utils";

type BackendOption = "console" | "smtp" | "resend";

const PROVIDERS: ReadonlyArray<{
  id: BackendOption;
  title: string;
  description: string;
}> = [
  {
    id: "console",
    title: "Local Outbox",
    description: "Capture invites and OTP codes in Local Outbox for offline testing.",
  },
  {
    id: "smtp",
    title: "SMTP Server",
    description: "Gmail, Outlook / M365, Fastmail, Amazon SES or any SMTP relay.",
  },
  {
    id: "resend",
    title: "Resend API",
    description: "Send transactional emails over HTTPS using your Resend API key.",
  },
];

const SMTP_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  hint: string;
}> = [
  {
    id: "gmail",
    label: "Gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    hint: "Use your Google email as username and a 16-character Google App Password (requires 2-Step Verification).",
  },
  {
    id: "outlook",
    label: "Outlook / M365",
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    hint: "Uses STARTTLS on port 587. Ensure Authenticated SMTP is enabled for your mailbox.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    host: "smtp.fastmail.com",
    port: 465,
    secure: true,
    hint: "Create a dedicated SMTP app password under Fastmail Settings > Privacy & Security.",
  },
  {
    id: "ses",
    label: "Amazon SES",
    host: "email-smtp.ap-southeast-2.amazonaws.com",
    port: 587,
    secure: false,
    hint: "Use SES SMTP credentials matching your AWS region and verified sending domain.",
  },
  {
    id: "custom",
    label: "Custom",
    host: "",
    port: 587,
    secure: false,
    hint: "Enter your mail server hostname, port and STARTTLS/SSL settings.",
  },
];

export function EmailSettings({
  email,
  defaultRecipient,
  workspaceName,
  onSaved,
}: {
  email: EmailSettingsDto;
  defaultRecipient: string;
  workspaceName: string;
  onSaved: () => Promise<void>;
}) {
  const [backend, setBackend] = useState<BackendOption>(email.backend);
  const [from, setFrom] = useState(email.from);
  const [replyTo, setReplyTo] = useState(email.replyTo);
  const [smtpHost, setSmtpHost] = useState(email.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(email.smtp.port || 587));
  const [smtpSecure, setSmtpSecure] = useState(email.smtp.secure);
  const [smtpUser, setSmtpUser] = useState(email.smtp.user);
  const [smtpPass, setSmtpPass] = useState("");
  const [resendApiKey, setResendApiKey] = useState("");
  const [activePresetHint, setActivePresetHint] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState(defaultRecipient);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setBackend(email.backend);
    setFrom(email.from);
    setReplyTo(email.replyTo);
    setSmtpHost(email.smtp.host);
    setSmtpPort(String(email.smtp.port || 587));
    setSmtpSecure(email.smtp.secure);
    setSmtpUser(email.smtp.user);
    setSmtpPass("");
    setResendApiKey("");
  }, [email]);

  const isDirty =
    backend !== email.backend ||
    from !== email.from ||
    replyTo !== email.replyTo ||
    (backend === "smtp" &&
      (smtpHost !== email.smtp.host ||
        Number(smtpPort) !== email.smtp.port ||
        smtpSecure !== email.smtp.secure ||
        smtpUser !== email.smtp.user ||
        smtpPass.length > 0)) ||
    (backend === "resend" && resendApiKey.length > 0);

  function applyPreset(preset: (typeof SMTP_PRESETS)[number]) {
    if (preset.host) setSmtpHost(preset.host);
    setSmtpPort(String(preset.port));
    setSmtpSecure(preset.secure);
    setActivePresetHint(preset.hint);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTestResult(null);
    try {
      await apiJson("/api/settings/email", {
        method: "PUT",
        body: JSON.stringify({
          backend,
          from: from.trim(),
          replyTo: replyTo.trim(),
          ...(backend === "smtp"
            ? {
                smtp: {
                  host: smtpHost.trim(),
                  port: Number.parseInt(smtpPort, 10) || 587,
                  secure: smtpSecure,
                  user: smtpUser.trim(),
                  ...(smtpPass ? { pass: smtpPass } : {}),
                },
              }
            : {}),
          ...(backend === "resend"
            ? {
                resend: {
                  ...(resendApiKey.trim() ? { apiKey: resendApiKey.trim() } : {}),
                },
              }
            : {}),
        }),
      });
      setSmtpPass("");
      setResendApiKey("");
      toast.success("Email delivery settings saved.");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save email settings.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiJson<{ ok: boolean; backend: string; to: string }>("/api/settings/email/test", {
        method: "POST",
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const msg =
        res.backend === "console"
          ? `Test email captured in Local Outbox for ${res.to}.`
          : `Test email sent to ${res.to} via ${res.backend.toUpperCase()}.`;
      setTestResult({ ok: true, text: msg });
      toast.success(msg);
      await onSaved();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Test email failed.";
      setTestResult({ ok: false, text: msg });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card className="paper-shadow">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <EnvelopeSimple className="size-4 text-primary" weight="duotone" />
              Outbound Email Delivery
            </CardTitle>
            <Badge variant="outline" className="text-[11px]">
              {email.source === "workspace" ? "Saved in encrypted vault" : "Using .env default"}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Choose how GatherGate delivers client magic links, 6-digit OTP codes, revision requests and reminders. Credentials are encrypted at rest with AES-256-GCM.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Email delivery provider">
              {PROVIDERS.map((p) => {
                const selected = backend === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setBackend(p.id);
                      setTestResult(null);
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:bg-muted/50"
                    )}
                  >
                    <span className="text-sm font-medium text-foreground">{p.title}</span>
                    <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {p.description}
                    </span>
                  </button>
                );
              })}
            </div>

            {backend !== "console" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="email-from">From address</Label>
                  <Input
                    id="email-from"
                    placeholder={`${workspaceName} <hello@yourdomain.com>`}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Format: <code className="font-mono">Practice Name &lt;email@domain.com&gt;</code>
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email-reply-to">Reply-to address (optional)</Label>
                  <Input
                    id="email-reply-to"
                    type="email"
                    placeholder="support@yourdomain.com"
                    value={replyTo}
                    onChange={(e) => setReplyTo(e.target.value)}
                  />
                </div>
              </div>
            )}

            {backend === "smtp" && (
              <div className="space-y-4 rounded-lg border border-border bg-muted/25 p-4">
                <div className="space-y-2">
                  <span className="text-xs font-medium text-foreground">Quick provider presets</span>
                  <div className="flex flex-wrap gap-1.5">
                    {SMTP_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        type="button"
                        variant={smtpHost === preset.host && preset.host ? "secondary" : "outline"}
                        size="xs"
                        onClick={() => applyPreset(preset)}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                  {activePresetHint && (
                    <p className="text-xs text-muted-foreground">{activePresetHint}</p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-host">SMTP host</Label>
                    <Input
                      id="smtp-host"
                      placeholder="smtp.gmail.com"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-port">Port</Label>
                    <Input
                      id="smtp-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      className="font-mono tabular-nums"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2.5">
                  <div>
                    <Label htmlFor="smtp-secure" className="text-sm font-medium">
                      Implicit TLS / SSL
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Enable for port 465 (Gmail, Fastmail). Leave off for STARTTLS on port 587.
                    </p>
                  </div>
                  <Switch id="smtp-secure" checked={smtpSecure} onCheckedChange={setSmtpSecure} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-user">SMTP username</Label>
                    <Input
                      id="smtp-user"
                      placeholder="you@gmail.com"
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-pass">SMTP password / app password</Label>
                    <PasswordInput
                      id="smtp-pass"
                      autoComplete="new-password"
                      placeholder={email.smtp.hasPass ? "Saved (leave blank to keep)" : "16-character app password"}
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {backend === "resend" && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="resend-key">Resend API key</Label>
                  <PasswordInput
                    id="resend-key"
                    autoComplete="new-password"
                    className="font-mono text-xs"
                    placeholder={email.resend.hasApiKey ? "Saved (leave blank to keep)" : "re_..."}
                    value={resendApiKey}
                    onChange={(e) => setResendApiKey(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Ensure your sending domain is verified in Resend before sending live emails.
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 text-primary" weight="duotone" />
                <span>Secrets encrypted via MASTER_KEY</span>
              </div>
              <Button type="submit" disabled={saving}>
                {saving && <CircleNotch className="size-4 animate-spin" />}
                Save email settings
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="paper-shadow">
        <CardHeader>
          <CardTitle className="text-base">Send test email</CardTitle>
          <CardDescription className="text-xs">
            Verify delivery using your currently saved configuration.
            {isDirty ? " Save your changes above first before testing new settings." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Test recipient email"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@practice.com"
              className="max-w-xs"
            />
            <Button
              type="button"
              variant="outline"
              disabled={testing || isDirty || !testTo.trim()}
              onClick={sendTest}
            >
              {testing ? (
                <CircleNotch className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <PaperPlaneTilt className="mr-1.5 size-3.5" />
              )}
              {testing ? "Sending..." : "Send test email"}
            </Button>
          </div>
          {testResult && (
            <div
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                testResult.ok
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-200"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              )}
            >
              {testResult.ok ? (
                <CheckCircle className="mt-0.5 size-4 shrink-0" weight="duotone" />
              ) : (
                <WarningCircle className="mt-0.5 size-4 shrink-0" weight="duotone" />
              )}
              <span>{testResult.text}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
