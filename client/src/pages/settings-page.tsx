import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import {
  CheckCircle,
  Copy,
  EnvelopeSimple,
  HardDrives,
  Key,
  Package,
  Palette,
  PaperPlaneTilt,
  Trash,
  UserCircle,
  WebhooksLogo,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { AccountSettings } from "@/components/account-settings";
import { AppShell } from "@/components/app-shell";
import { BrandingSettings } from "@/components/branding-settings";
import { EmailSettings } from "@/components/email-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiJson,
  ApiError,
  formatBytes,
  type SessionResponse,
  type SettingsResponse,
} from "@/lib/api";
import { cn, copyText } from "@/lib/utils";

type SettingsSection = "branding" | "email" | "account" | "webhooks" | "instance";

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: typeof Palette;
}> = [
  { id: "branding", label: "Branding", icon: Palette },
  { id: "email", label: "Email Delivery", icon: EnvelopeSimple },
  { id: "account", label: "Account & Security", icon: UserCircle },
  { id: "webhooks", label: "Webhooks", icon: WebhooksLogo },
  { id: "instance", label: "Instance & Data", icon: HardDrives },
];

function parseSection(raw: string | null): SettingsSection {
  return SECTIONS.some((s) => s.id === raw) ? (raw as SettingsSection) : "branding";
}

export function SettingsPage({
  session,
  onSessionRefresh,
  theme,
  onToggleTheme,
}: {
  session: SessionResponse;
  onSessionRefresh: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSection = parseSection(searchParams.get("section"));

  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const s = await apiJson<SettingsResponse>("/api/settings");
      setSettings(s);
      setWebhookUrl(s.webhookUrl);
      setWebhookSecret(s.webhookSecret);
    } catch {
      toast.error("Failed to load settings.");
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function selectSection(section: SettingsSection) {
    setSearchParams({ section }, { replace: true });
  }

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

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Settings" }]}
      onSessionRefresh={onSessionRefresh}
      onDemoChanged={loadAll}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage client portal branding, outbound email providers, account security, webhooks and vault storage.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav
            aria-label="Settings sections"
            className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5"
          >
            {SECTIONS.map((item) => {
              const active = activeSection === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => selectSection(item.id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <Icon
                    className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0">
            {activeSection === "branding" && settings && (
              <BrandingSettings
                branding={settings.branding}
                onSaved={async () => {
                  await Promise.all([loadAll(), onSessionRefresh()]);
                }}
              />
            )}

            {activeSection === "email" && settings && (
              <EmailSettings
                email={settings.email}
                defaultRecipient={settings.account.email}
                workspaceName={settings.account.workspaceName}
                onSaved={async () => {
                  await Promise.all([loadAll(), onSessionRefresh()]);
                }}
              />
            )}

            {activeSection === "account" && settings && (
              <AccountSettings
                account={settings.account}
                onSaved={async () => {
                  await Promise.all([loadAll(), onSessionRefresh()]);
                }}
              />
            )}

            {activeSection === "webhooks" && (
              <Card className="paper-shadow max-w-2xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <WebhooksLogo className="size-4 text-primary" />
                    Completion Webhook (n8n / Automation)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    When every required item in a checklist is approved, GatherGate POSTs a signed{" "}
                    <code className="font-mono">request.completed</code> payload with{" "}
                    <code className="font-mono">x-gathergate-signature</code> HMAC-SHA256. Sensitive identifiers (TFN, Medicare, UK NINO, US SSN) stay masked.
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
                          <Key className="mr-1.5 size-3.5" />
                          Generate
                        </Button>
                        {webhookSecret && (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label="Copy signing secret"
                            onClick={async () => {
                              const ok = await copyText(webhookSecret);
                              if (ok) toast.success("Secret copied.");
                              else toast.error("Could not copy signing secret.");
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
                        <PaperPlaneTilt className="mr-1.5 size-3.5" />
                        {testingWebhook ? "Sending..." : "Send test event"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {activeSection === "instance" && settings && (
              <div className="grid max-w-3xl gap-4 md:grid-cols-2">
                <Card className="paper-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CheckCircle className="size-4 text-primary" />
                      Encryption & Vault
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">AES-256-GCM Master Key</span>
                      {settings.readiness.masterKeySource === "file" ? (
                        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                          Auto-generated in DATA_DIR
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                          {settings.readiness.masterKeyConfigured ? "Env variable (32-byte HKDF)" : "Missing"}
                        </Badge>
                      )}
                    </div>
                    {settings.readiness.masterKeySource === "file" && (
                      <p className="rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                        Copy the 64-hex key from <code className="font-mono">DATA_DIR/.master.key</code> into your{" "}
                        <code className="font-mono">MASTER_KEY</code> environment variable, restart GatherGate, then remove{" "}
                        <code className="font-mono">.master.key</code> from the data directory.
                      </p>
                    )}
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
                      <EnvelopeSimple className="size-4 text-primary" />
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
                    <div className="flex justify-between gap-2">
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
                      <Trash className="mr-1.5 size-4" />
                      Clear demo data
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
