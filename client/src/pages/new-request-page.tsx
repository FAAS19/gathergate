import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Mail, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  apiJson,
  ApiError,
  VALIDATOR_OPTIONS,
  type SessionResponse,
  type TemplateDto,
} from "@/lib/api";

export function NewRequestPage({
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTemplateId = searchParams.get("templateId");

  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [includedIndices, setIncludedIndices] = useState<number[]>([]);

  const [title, setTitle] = useState("");
  const [clientSubject, setClientSubject] = useState("");
  const [welcomeNote, setWelcomeNote] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [cadence, setCadence] = useState("3");
  const [maxReminders, setMaxReminders] = useState("4");
  const [purgeAfterDays, setPurgeAfterDays] = useState(
    String(session.readiness.defaultPurgeDays || 30)
  );
  const [requireOtp, setRequireOtp] = useState(false);
  const [sendInvite, setSendInvite] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiJson<{ templates: TemplateDto[] }>("/api/templates")
      .then((res) => {
        setTemplates(res.templates);
        const target =
          res.templates.find((t) => t.id === initialTemplateId) ?? res.templates[0];
        if (target) {
          setSelectedTemplateId(target.id);
          setIncludedIndices(target.items.map((_, i) => i));
          setTitle(target.name);
        }
      })
      .catch(() => toast.error("Failed to load templates."));
  }, [initialTemplateId]);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );

  const selectedItems = useMemo(() => {
    if (!activeTemplate) return [];
    return activeTemplate.items.filter((_, idx) => includedIndices.includes(idx));
  }, [activeTemplate, includedIndices]);

  const hasSensitiveFields = useMemo(
    () =>
      selectedItems.some(
        (i) => i.validator === "au_tfn_mod11" || i.validator === "au_medicare_mod10"
      ),
    [selectedItems]
  );

  function selectTemplate(tpl: TemplateDto) {
    setSelectedTemplateId(tpl.id);
    setIncludedIndices(tpl.items.map((_, i) => i));
    if (!title || templates.some((t) => t.name === title)) {
      setTitle(tpl.name);
    }
    const sensitive = tpl.items.some(
      (i) => i.validator === "au_tfn_mod11" || i.validator === "au_medicare_mod10"
    );
    setRequireOtp(sensitive);
  }

  function toggleItemIndex(idx: number) {
    setIncludedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort((a, b) => a - b)
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!activeTemplate || selectedItems.length === 0) {
      toast.error("Include at least one checklist item.");
      return;
    }
    setSubmitting(true);
    try {
      const intervalDays = Number(cadence);
      const res = await apiJson<{ id: string }>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          templateId: activeTemplate.id,
          title,
          clientSubject: clientSubject.trim() || undefined,
          welcomeNote: welcomeNote.trim() || undefined,
          clientName,
          clientEmail,
          items: selectedItems,
          requireOtp,
          sendInvite,
          reminderIntervalDays: intervalDays,
          maxReminders: intervalDays === 0 ? 0 : Number(maxReminders),
          purgeAfterDays: Number(purgeAfterDays),
          dueAt: dueAt ? new Date(`${dueAt}T17:00:00Z`).toISOString() : null,
        }),
      });
      toast.success(sendInvite ? "Checklist dispatched to client." : "Checklist created.");
      navigate(`/requests/${res.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create request.");
    } finally {
      setSubmitting(false);
    }
  }

  const validatorShort = (key: string) =>
    VALIDATOR_OPTIONS.find((v) => v.value === key)?.short ?? key;

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Requests", to: "/" }, { label: "New Request" }]}
      onSessionRefresh={onSessionRefresh}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Checklist Request</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a starter or custom pack, tailor included items, and generate a magic-link portal.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-7">
            {/* Step 1: Visual Template Picker */}
            <Card className="paper-shadow">
              <CardHeader>
                <CardTitle className="text-base">1. Select checklist template</CardTitle>
                <CardDescription className="text-xs">
                  Pick a template, then uncheck optional items you do not need for this client.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {templates.map((tpl) => {
                    const active = tpl.id === selectedTemplateId;
                    const vals = [
                      ...new Set(tpl.items.map((i) => i.validator).filter((v) => v && v !== "none")),
                    ];
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => selectTemplate(tpl)}
                        className={`rounded-lg border p-3.5 text-left transition-all ${
                          active
                            ? "border-primary bg-accent/60 ring-1 ring-primary/30"
                            : "border-border bg-card hover:border-primary/40"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">{tpl.name}</span>
                          {tpl.is_builtin && <span className="shrink-0 text-[11px] text-muted-foreground">Starter</span>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[10px] font-normal tabular-nums">
                            {tpl.items.length} items
                          </Badge>
                          {vals.slice(0, 2).map((v) => (
                            <Badge key={v} variant="secondary" className="text-[10px] font-normal">
                              {validatorShort(v)}
                            </Badge>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {activeTemplate && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3.5">
                    <p className="mb-2 text-xs font-medium text-foreground">
                      Included items ({selectedItems.length} of {activeTemplate.items.length})
                    </p>
                    <div className="space-y-2">
                      {activeTemplate.items.map((item, idx) => (
                        <label key={idx} className="flex items-start gap-2.5 text-xs cursor-pointer">
                          <Checkbox
                            checked={includedIndices.includes(idx)}
                            onCheckedChange={() => toggleItemIndex(idx)}
                            className="mt-0.5"
                          />
                          <span className="flex-1">
                            <span className="font-medium text-foreground">{item.label}</span>
                            <span className="ml-1.5 text-muted-foreground">({item.kind})</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Step 2: Client & Messaging */}
            <Card className="paper-shadow">
              <CardHeader>
                <CardTitle className="text-base">2. Client details & messaging</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="clientName">Client name</Label>
                    <Input
                      id="clientName"
                      required
                      placeholder="Claire Nguyen"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="clientEmail">Client email</Label>
                    <Input
                      id="clientEmail"
                      type="email"
                      required
                      placeholder="claire@client.com.au"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="title">Internal checklist title</Label>
                    <Input
                      id="title"
                      required
                      placeholder="FY26 Individual Tax Return Pack"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dueAt">Target due date (optional)</Label>
                    <Input
                      id="dueAt"
                      type="date"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="clientSubject">Client email subject (optional)</Label>
                  <Input
                    id="clientSubject"
                    placeholder={`${session.workspace?.name || "GatherGate"}: Action required - ${title || "Document checklist"}`}
                    value={clientSubject}
                    onChange={(e) => setClientSubject(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="welcomeNote">Personal note shown in email & portal (optional)</Label>
                  <Textarea
                    id="welcomeNote"
                    rows={2}
                    placeholder="Please upload your receipts before Friday so we can lodge your return on time."
                    value={welcomeNote}
                    onChange={(e) => setWelcomeNote(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Step 3: Security, Auto-Chaser & Retention */}
            <Card className="paper-shadow">
              <CardHeader>
                <CardTitle className="text-base">3. Follow-ups, OTP security & retention</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cadence">Reminder cadence</Label>
                    <Select value={cadence} onValueChange={setCadence}>
                      <SelectTrigger id="cadence">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3">Standard · every 3 days</SelectItem>
                        <SelectItem value="4">Gentle · every 4 days</SelectItem>
                        <SelectItem value="1">Urgent · daily</SelectItem>
                        <SelectItem value="0">Off (manual only)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="maxReminders">Max follow-ups</Label>
                    <Input
                      id="maxReminders"
                      type="number"
                      min={0}
                      max={20}
                      disabled={cadence === "0"}
                      value={maxReminders}
                      onChange={(e) => setMaxReminders(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="purgeAfterDays">Auto-purge (days)</Label>
                    <Input
                      id="purgeAfterDays"
                      type="number"
                      min={1}
                      max={365}
                      value={purgeAfterDays}
                      onChange={(e) => setPurgeAfterDays(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="requireOtp" className="text-sm font-medium">
                        Require 6-digit email OTP verification
                      </Label>
                      {hasSensitiveFields && (
                        <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Protects TFN, Medicare, and identity packs even if an email link is forwarded.
                    </p>
                  </div>
                  <Switch id="requireOtp" checked={requireOtp} onCheckedChange={setRequireOtp} />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                  <div>
                    <Label htmlFor="sendInvite" className="text-sm font-medium">
                      Send magic-link invite immediately
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {session.readiness.emailBackend === "console"
                        ? "Routes to Local Preview Outbox (SMTP not configured)."
                        : `Sends via ${session.readiness.emailBackend.toUpperCase()}.`}
                    </p>
                  </div>
                  <Switch id="sendInvite" checked={sendInvite} onCheckedChange={setSendInvite} />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sticky Live Invite & Checklist Preview */}
          <div className="lg:col-span-5">
            <div className="sticky top-20 space-y-4">
              <Card className="paper-shadow">
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Mail className="size-3.5 text-primary" />
                    Client Email Invite Preview
                  </div>
                  <CardTitle className="text-sm font-semibold">
                    {clientSubject.trim() ||
                      `${session.workspace?.name || "GatherGate"}: Action required - ${title || "Document checklist"}`}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    To: {clientEmail || "client@example.com.au"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-4 text-xs text-muted-foreground">
                  <p>Hi {clientName || "there"},</p>
                  <p>
                    <strong className="text-foreground">{session.workspace?.name}</strong> has prepared a secure document checklist for{" "}
                    <strong className="text-foreground">"{title || "your onboarding"}"</strong>.
                  </p>
                  {welcomeNote.trim() && (
                    <blockquote className="rounded border-l-2 border-primary bg-muted/50 px-3 py-2 text-foreground">
                      {welcomeNote.trim()}
                    </blockquote>
                  )}
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                    <p className="font-medium text-foreground">Items requested ({selectedItems.length}):</p>
                    <ul className="mt-1 space-y-0.5">
                      {selectedItems.map((it, i) => (
                        <li key={i} className="truncate">
                          · {it.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {requireOtp && (
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-800 dark:text-amber-300">
                      <ShieldCheck className="size-3.5" />
                      Client will verify a 6-digit email OTP before uploading.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                {submitting
                  ? "Creating magic link..."
                  : sendInvite
                    ? "Create & send magic link"
                    : "Create checklist request"}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
