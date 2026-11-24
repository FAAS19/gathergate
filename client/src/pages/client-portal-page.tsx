import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { AlertTriangle, Check, CheckCircle2, Lock, ListChecks, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { FileField } from "@/components/portal/file-field";
import { ItemNote } from "@/components/portal/item-note";
import { OtpGate } from "@/components/portal/otp-gate";
import { TextField } from "@/components/portal/text-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiJson, ApiError, type BrandingDto, type ClientPortalResponse, type RequestItemDto } from "@/lib/api";
import { brandStyle } from "@/lib/brand";
import { cn } from "@/lib/utils";

const isDone = (i: RequestItemDto) => i.status === "submitted" || i.status === "approved";

function scrollToItem(id: string) {
  const el = document.getElementById(`portal-item-${id}`);
  el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el?.querySelector<HTMLElement>("input, textarea, button, [tabindex='0']")?.focus({ preventScroll: true });
}

function formatDue(iso: string | null | undefined, style: "short" | "long" = "short") {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-AU", style === "long" ? { weekday: "long", day: "numeric", month: "long" } : { day: "numeric", month: "short" });
}

function FirmMark({ branding }: { branding: BrandingDto }) {
  return branding.logoDataUrl ? (
    <img src={branding.logoDataUrl} alt={branding.name} className="h-7 max-w-[160px] object-contain" />
  ) : (
    <span className="flex items-center gap-2.5">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
        {branding.name.charAt(0).toUpperCase()}
      </span>
      <span className="truncate text-sm font-semibold tracking-tight">{branding.name}</span>
    </span>
  );
}

function StatusDot({ item }: { item: RequestItemDto }) {
  if (item.status === "approved") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" title="Accepted">
        <Lock className="size-3" />
      </span>
    );
  }
  if (item.status === "submitted") {
    return (
      <span
        key="done"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground animate-in zoom-in-50 fade-in duration-200 motion-reduce:animate-none"
        title="Done"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (item.status === "rejected") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700" title="Needs an update">
        <AlertTriangle className="size-3.5" />
      </span>
    );
  }
  return <span className="size-6 shrink-0 rounded-full border-2 border-input" title="To do" />;
}

function SectionNav({ sections, onPick }: { sections: Array<[string, RequestItemDto[]]>; onPick: (id: string) => void }) {
  return (
    <nav aria-label="Checklist sections" className="space-y-5">
      {sections.map(([name, items]) => (
        <div key={name}>
          <p className="mb-1.5 px-2 text-xs font-medium text-muted-foreground">{name}</p>
          <ul>
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => onPick(it.id)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full transition-colors duration-300",
                      isDone(it) ? "bg-primary" : it.status === "rejected" ? "bg-amber-500" : "bg-input"
                    )}
                  />
                  <span className={cn("truncate", isDone(it) && "text-muted-foreground")}>{it.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function CenteredShell({ branding, children }: { branding?: BrandingDto; children: ReactNode }) {
  return (
    <div style={brandStyle(branding?.brandColor)} className="light flex min-h-screen flex-col items-center bg-background px-4 py-10 text-foreground">
      {branding && (
        <div className="mb-10">
          <FirmMark branding={branding} />
        </div>
      )}
      <div className="flex w-full flex-1 flex-col items-center justify-center pb-16">{children}</div>
      <PortalFooter branding={branding} />
    </div>
  );
}

function PortalFooter({ branding }: { branding?: BrandingDto }) {
  const contact = [branding?.supportEmail, branding?.supportPhone].filter(Boolean) as string[];
  return (
    <footer className="flex flex-col items-center gap-3 px-4 text-center text-xs text-muted-foreground">
      {branding && contact.length > 0 && (
        <p>
          Questions? Contact {branding.name} at{" "}
          {contact.map((c, i) => (
            <span key={c}>
              {i > 0 && " or "}
              <a
                href={c.includes("@") ? `mailto:${c}` : `tel:${c.replace(/[^\d+]/g, "")}`}
                className="whitespace-nowrap font-medium text-foreground underline-offset-4 hover:underline"
              >
                {c}
              </a>
            </span>
          ))}
        </p>
      )}
      <p className="flex items-center gap-1.5">
        <ShieldCheck className="size-3.5" /> Encrypted on arrival · Secured by GatherGate
      </p>
    </footer>
  );
}

function CompletionCard({ data, items }: { data: ClientPortalResponse; items: RequestItemDto[] }) {
  const complete = data.request.status === "completed";
  const firstName = data.request.client_name.split(" ")[0];
  const na = items.filter((i) => i.client_na).length;
  return (
    <div
      role="status"
      className="rounded-xl border border-border bg-card p-6 text-center shadow-[0_1px_2px_rgba(17,24,28,0.04)] animate-in fade-in zoom-in-95 duration-500 motion-reduce:animate-none sm:p-8"
    >
      <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
        <CheckCircle2 className="size-6" />
      </span>
      <h2 className="mt-4 text-xl font-semibold tracking-tight">
        {complete ? "Everything's been accepted" : `All done, ${firstName}`}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {complete
          ? `${data.branding.name} has reviewed and accepted every item. Nothing else is needed from you.`
          : `${data.branding.name} has what they need. You'll only hear from them if something needs another look.`}
      </p>
      <p className="mt-5 text-xs tabular-nums text-muted-foreground">
        {items.length} items{na > 0 ? `, ${na} marked not applicable` : ""}
        {data.request.completed_at && ` · Completed ${new Date(data.request.completed_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}`}
      </p>
    </div>
  );
}

function ItemCard({
  item,
  token,
  requestClosed,
  onChanged,
}: {
  item: RequestItemDto;
  token: string;
  requestClosed: boolean;
  onChanged: () => Promise<void>;
}) {
  const locked = item.status === "approved" || requestClosed;
  const [savingCheck, setSavingCheck] = useState(false);

  async function confirmDeclaration() {
    setSavingCheck(true);
    try {
      await apiJson(`/api/client/${token}/items/${item.id}`, { method: "POST", body: JSON.stringify({ checked: true }) });
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setSavingCheck(false);
    }
  }

  return (
    <article
      id={`portal-item-${item.id}`}
      aria-labelledby={`label-${item.id}`}
      className={cn(
        "scroll-mt-28 rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgba(17,24,28,0.04)] transition-colors duration-300 sm:p-6",
        item.status === "rejected" ? "border-amber-300" : "border-border"
      )}
    >
      <div className="flex items-start gap-3.5">
        <StatusDot item={item} />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h3 id={`label-${item.id}`} className="font-sans text-[15px] font-semibold leading-6">
              {item.label}
              {!item.required && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}
            </h3>
            {item.help_text && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.help_text}</p>}
          </div>

          {item.status === "rejected" && item.review_note && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-950">
              <span className="font-medium">Please update:</span> {item.review_note}
            </div>
          )}

          {!item.client_na && item.kind === "file" && (
            <FileField item={item} token={token} locked={locked} onChanged={onChanged} />
          )}
          {!item.client_na && (item.kind === "text" || item.kind === "textarea") && (
            <TextField item={item} token={token} locked={locked} onChanged={onChanged} />
          )}
          {!item.client_na && item.kind === "checkbox" && (
            <label className={cn("flex items-start gap-3 text-sm", locked ? "cursor-default" : "cursor-pointer")}>
              <Checkbox
                className="mt-0.5"
                checked={item.currentValue === "confirmed"}
                disabled={locked || savingCheck || item.currentValue === "confirmed"}
                onCheckedChange={(c) => c === true && confirmDeclaration()}
              />
              <span>I confirm the above is true and correct</span>
            </label>
          )}

          {item.kind !== "checkbox" && <ItemNote item={item} token={token} locked={locked} onChanged={onChanged} />}
        </div>
      </div>
    </article>
  );
}

export function ClientPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ClientPortalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setData(await apiJson<ClientPortalResponse>(`/api/client/${token}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "This link isn't working.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data) document.title = `${data.request.title} · ${data.branding.name}`;
  }, [data]);

  const items = data?.items ?? [];
  const sections = useMemo(() => {
    const groups = new Map<string, RequestItemDto[]>();
    for (const it of items) groups.set(it.section, [...(groups.get(it.section) ?? []), it]);
    return [...groups.entries()];
  }, [items]);

  if (loading) {
    return (
      <div className="light min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-2xl space-y-4" aria-busy="true" aria-label="Loading checklist">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="mt-8 h-9 w-2/3" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <CenteredShell>
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold tracking-tight">This link isn't working</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may have expired or been replaced. Ask the person who sent it for a new link.
          </p>
        </div>
      </CenteredShell>
    );
  }

  if (data.request.status === "purged") {
    return (
      <CenteredShell branding={data.branding}>
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold tracking-tight">This checklist has closed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The files for {data.request.title} were permanently deleted under {data.branding.name}'s retention policy.
          </p>
        </div>
      </CenteredShell>
    );
  }

  if (data.requiresOtp) {
    return (
      <CenteredShell branding={data.branding}>
        <OtpGate token={token!} maskedEmail={data.request.maskedEmail ?? "your email"} title={data.request.title} onVerified={load} />
      </CenteredShell>
    );
  }

  const done = items.filter(isDone).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const rejected = items.filter((i) => i.status === "rejected");
  const requiredDone = items.filter((i) => i.required).every(isDone) && rejected.length === 0;
  const requestClosed = data.request.status === "completed";
  const due = formatDue(data.request.due_at, "long");
  const firstName = data.request.client_name.split(" ")[0];
  const pick = (id: string) => {
    setSheetOpen(false);
    // Let the sheet close before scrolling so focus lands on the item.
    setTimeout(() => scrollToItem(id), 150);
  };

  return (
    <div style={brandStyle(data.branding.brandColor)} className="light min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <FirmMark branding={data.branding} />
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
              <span className="font-medium text-foreground">{done}</span> of {items.length} done
            </span>
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="lg:hidden" aria-label="Jump to an item">
                  <ListChecks className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="light max-h-[75vh] overflow-y-auto rounded-t-xl bg-background text-foreground" style={brandStyle(data.branding.brandColor)}>
                <SheetHeader>
                  <SheetTitle>Jump to an item</SheetTitle>
                </SheetHeader>
                <div className="px-2 pb-6">
                  <SectionNav sections={sections} onPick={pick} />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
        <div
          className="h-0.5 bg-muted"
          role="progressbar"
          aria-label="Checklist progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pb-16 pt-10 sm:px-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <SectionNav sections={sections} onPick={scrollToItem} />
          </div>
        </aside>

        <main className="mx-auto w-full max-w-2xl">
          <div className="mb-8">
            <p className="text-sm text-muted-foreground">Hi {firstName},</p>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.025em] sm:text-[30px]">
              {data.request.title}
            </h1>
            {data.request.welcome_note && (
              <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-muted-foreground">{data.request.welcome_note}</p>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              {items.length} items{due && <> · Please finish by <span className="font-medium text-foreground">{due}</span></>} · Your progress saves automatically
            </p>
          </div>

          {rejected.length > 0 && (
            <div role="alert" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4 text-amber-700" />
                {rejected.length === 1 ? "1 item needs an update" : `${rejected.length} items need an update`}
              </p>
              <ul className="mt-2 space-y-1 pl-6 text-sm">
                {rejected.map((it) => (
                  <li key={it.id}>
                    <button type="button" onClick={() => scrollToItem(it.id)} className="underline underline-offset-4 hover:text-amber-800">
                      {it.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {requiredDone && (
            <div className="mb-8">
              <CompletionCard data={data} items={items} />
            </div>
          )}

          <div className="space-y-10">
            {sections.map(([name, sectionItems], idx) => (
              <section key={name} aria-labelledby={`section-${idx}`}>
                <h2 id={`section-${idx}`} className="mb-3 text-sm font-medium text-muted-foreground">
                  {name}
                </h2>
                <div className="space-y-3">
                  {sectionItems.map((item) => (
                    <ItemCard key={item.id} item={item} token={token!} requestClosed={requestClosed} onChanged={load} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>

      <div className="pb-10">
        <PortalFooter branding={data.branding} />
      </div>
    </div>
  );
}
