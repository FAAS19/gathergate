import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Inbox,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  Package,
  Palette,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { BrandingSettings } from "@/components/branding-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apiJson,
  ApiError,
  formatBytes,
  formatRelativeTime,
  type OutboxEmailDto,
  type SessionResponse,
  type SettingsResponse,
} from "@/lib/api";

function extractMagicUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+\/c\/[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function extractOtpCode(subject: string, text: string): string | null {
  const m = subject.match(/^(\d{6}) is your verification code/i) || text.match(/\n(\d{6})\n/);
  return m ? m[1] : null;
}

export function SettingsPage({
  session,
  defaultTab = "webhooks",
  onSessionRefresh,
  theme,
  onToggleTheme,
}: {
  session: SessionResponse;
  defaultTab?: "branding" | "webhooks" | "readiness" | "outbox";
  onSessionRefresh: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [tab, setTab] = useState(defaultTab);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const [outbox, setOutbox] = useState<OutboxEmailDto[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [emailView, setEmailView] = useState<"html" | "text">("html");

  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const loadAll = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        apiJson<SettingsResponse>("/api/settings"),
        apiJson<{ emails: OutboxEmailDto[] }>("/api/outbox"),
      ]);
      setSettings(s);
      setWebhookUrl(s.webhookUrl);
      setWebhookSecret(s.webhookSecret);
      setOutbox(o.emails);
      if (o.emails.length > 0) {
        setSelectedEmailId((prev) => prev ?? o.emails[0].id);
      }
    } catch {
      toast.error("Failed to load settings.");
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function generateSecret() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    setWebhookSecret(`whsec_${hex}`);
  }

  async function saveWebhook(e: FormEvent) {
    e.preventDefault();
    setSavingWebhook(true);
    try {
      await apiJson("/api/settings/webhook", {
        method: "PUT",
        body: JSON.stringify({ webhookUrl, webhookSecret }),
      });
      toast.success("Webhook settings saved.");
      await loadAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save webhook.");
    } finally {
      setSavingWebhook(false);
    }
  }

  async function testWebhook() {
    setTestingWebhook(true);
    try {
      const res = await apiJson<{ status?: number }>("/api/settings/webhook/test", {
        method: "POST",
      });
      toast.success(`Test event delivered (HTTP ${res.status ?? 200}).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Webhook test failed.");
    } finally {
      setTestingWebhook(false);
    }
  }

  const activeEmail = outbox.find((e) => e.id === selectedEmailId) ?? outbox[0] ?? null;
  const activeMagicUrl = activeEmail ? extractMagicUrl(activeEmail.text_body) : null;
  const activeOtp = activeEmail ? extractOtpCode(activeEmail.subject, activeEmail.text_body) : null;

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: tab === "outbox" ? "Local Email Outbox" : "Settings" }]}
      onSessionRefresh={onSessionRefresh}
      onDemoChanged={loadAll}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {tab === "outbox" ? "Local Email Outbox" : "Settings"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Brand the client portal, connect automations, check instance health and preview client emails.
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-6">
          <TabsList>
            <TabsTrigger value="branding" className="gap-1.5">
              <Palette className="size-3.5" />
              Branding
            </TabsTrigger>
            <TabsTrigger value="webhooks" className="gap-1.5">
              <Webhook className="size-3.5" />
              Automation & Webhooks
            </TabsTrigger>
            <TabsTrigger value="readiness" className="gap-1.5">
              <ShieldCheck className="size-3.5" />
              Instance Readiness
            </TabsTrigger>
            <TabsTrigger value="outbox" className="gap-1.5">
              <Inbox className="size-3.5" />
              Local Email Outbox
              {outbox.length > 0 && (
                <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px] tabular-nums">
                  {outbox.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="branding">
            {settings && (
              <BrandingSettings
                branding={settings.branding}
                onSaved={async () => {
                  await Promise.all([loadAll(), onSessionRefresh()]);
                }}
              />
            )}
          </TabsContent>

          {/* Tab 1: Webhooks */}
          <TabsContent value="webhooks">
            <Card className="paper-shadow max-w-2xl">
              <CardHeader>
                <CardTitle className="text-base">Completion Webhook (n8n / Automation)</CardTitle>
                <CardDescription className="text-xs">
                  When every required item in a checklist is approved, GatherGate POSTs a signed{" "}
                  <code className="font-mono">request.completed</code> payload with{" "}
                  <code className="font-mono">x-gathergate-signature</code> HMAC-SHA256. Sensitive identifiers (TFN/Medicare) stay masked.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={saveWebhook} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="wh-url">Webhook Endpoint URL</Label>
                    <Input
                      id="wh-url"
                      type="url"
                      placeholder="https://n8n.example.com/webhook/gathergate"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wh-secret">HMAC-SHA256 Signing Secret</Label>
                    <div className="flex gap-2">
                      <Input
                        id="wh-secret"
                        className="font-mono text-xs"
                        placeholder="whsec_..."
                        value={webhookSecret}
                        onChange={(e) => setWebhookSecret(e.target.value)}
                      />
                      <Button type="button" variant="outline" size="sm" onClick={generateSecret}>
                        <KeyRound className="mr-1.5 size-3.5" />
                        Generate
                      </Button>
                      {webhookSecret && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Copy signing secret"
                          onClick={async () => {
                            await navigator.clipboard.writeText(webhookSecret);
                            toast.success("Secret copied.");
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <Button type="submit" disabled={savingWebhook}>
                      {savingWebhook ? "Saving..." : "Save webhook settings"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={testingWebhook || !webhookUrl}
                      onClick={testWebhook}
                    >
                      <Send className="mr-1.5 size-3.5" />
                      {testingWebhook ? "Sending..." : "Send test event"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 2: Instance Readiness */}
          <TabsContent value="readiness">
            {settings && (
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="paper-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CheckCircle2 className="size-4 text-primary" />
                      Encryption & Vault
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">AES-256-GCM Master Key</span>
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                        {settings.readiness.masterKeyConfigured ? "Active (32-byte HKDF)" : "Missing"}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Storage Adapter</span>
                      <span className="font-mono text-xs uppercase">{settings.readiness.storageBackend}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Encrypted Blob Footprint</span>
                      <span className="font-mono text-xs tabular-nums">
                        {formatBytes(settings.readiness.storageBytes)}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Card className="paper-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Inbox className="size-4 text-primary" />
                      Email & Background Workers
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Email Delivery</span>
                      <span className="font-mono text-xs">
                        {settings.readiness.emailBackend === "console"
                          ? "Local Preview Outbox"
                          : settings.readiness.emailBackend.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Sender Address</span>
                      <span className="truncate font-mono text-xs">{settings.readiness.emailFrom}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Chaser & Purge Cron</span>
                      <span className="font-mono text-xs tabular-nums">
                        Every {settings.readiness.cronIntervalMinutes}m · {settings.readiness.defaultPurgeDays}d purge
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Card className="paper-shadow md:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-base">Sample Demo Data</CardTitle>
                    <CardDescription className="text-xs">
                      Seed 3 realistic Australian checklists (tax pack with blurry scan, BAS pack, completed health intake) or remove them cleanly.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await apiJson("/api/demo/seed", { method: "POST" });
                        toast.success("Sample packs loaded.");
                        await onSessionRefresh();
                        await loadAll();
                      }}
                    >
                      <Package className="mr-1.5 size-4" />
                      Load sample workspace
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!settings.readiness.hasDemoData}
                      onClick={async () => {
                        await apiJson("/api/demo/clear", { method: "POST" });
                        toast.success("Demo data purged.");
                        await onSessionRefresh();
                        await loadAll();
                      }}
                    >
                      <Trash2 className="mr-1.5 size-4" />
                      Clear demo data
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* Tab 3: Local Email Outbox */}
          <TabsContent value="outbox">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                When <code className="font-mono">EMAIL_BACKEND=console</code>, invites, 6-digit OTP codes, revision requests, and scheduled reminders appear here so you can test every step locally.
              </p>
              <Button variant="outline" size="sm" onClick={loadAll}>
                <RefreshCw className="mr-1.5 size-3.5" />
                Refresh
              </Button>
            </div>

            {outbox.length === 0 ? (
              <Card className="paper-shadow p-10 text-center text-sm text-muted-foreground">
                No outbound emails recorded yet. Create a checklist request or trigger an OTP to inspect emails here.
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-12">
                <Card className="paper-shadow overflow-hidden lg:col-span-5">
                  <div className="divide-y divide-border max-h-[540px] overflow-y-auto">
                    {outbox.map((msg) => {
                      const active = activeEmail?.id === msg.id;
                      return (
                        <button
                          key={msg.id}
                          type="button"
                          onClick={() => setSelectedEmailId(msg.id)}
                          className={`w-full px-4 py-3 text-left transition-colors ${
                            active ? "bg-accent/70" : "hover:bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {msg.kind === "otp" ? "Code" : msg.kind}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {formatRelativeTime(msg.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-sm font-medium text-foreground">
                            {msg.subject}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">To: {msg.recipient}</p>
                        </button>
                      );
                    })}
                  </div>
                </Card>

                <Card className="paper-shadow lg:col-span-7">
                  {activeEmail && (
                    <CardContent className="space-y-4 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                        <div>
                          <h2 className="text-base font-semibold text-foreground">
                            {activeEmail.subject}
                          </h2>
                          <p className="mt-1 text-xs text-muted-foreground">
                            To: <span className="font-mono text-foreground">{activeEmail.recipient}</span>
                            {" · "}
                            {new Date(activeEmail.created_at).toLocaleString("en-AU")}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {activeOtp && (
                            <Badge className="font-mono text-xs">OTP: {activeOtp}</Badge>
                          )}
                          {activeMagicUrl && (
                            <Button asChild size="sm">
                              <a href={activeMagicUrl} target="_blank" rel="noopener noreferrer">
                                Open magic link
                                <ExternalLink className="ml-1.5 size-3.5" />
                              </a>
                            </Button>
                          )}
                        </div>
                      </div>

                      {activeEmail.html_body && (
                        <Tabs value={emailView} onValueChange={(v) => setEmailView(v as "html" | "text")}>
                          <TabsList className="h-8">
                            <TabsTrigger value="html" className="text-xs">Email</TabsTrigger>
                            <TabsTrigger value="text" className="text-xs">Plain text</TabsTrigger>
                          </TabsList>
                        </Tabs>
                      )}
                      {activeEmail.html_body && emailView === "html" ? (
                        // Empty sandbox: no scripts, no same-origin access, no forms.
                        <iframe
                          title={`Preview of ${activeEmail.subject}`}
                          sandbox=""
                          srcDoc={activeEmail.html_body}
                          className="h-[560px] w-full rounded-lg border border-border bg-white"
                        />
                      ) : (
                        <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                          {activeEmail.text_body}
                        </pre>
                      )}
                    </CardContent>
                  )}
                </Card>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
