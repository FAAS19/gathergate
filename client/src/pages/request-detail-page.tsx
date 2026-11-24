import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import {
  ArrowSquareOut as ExternalLink,
  CalendarBlank as Calendar,
  Checks as CheckCheck,
  ClockCounterClockwise as History,
  Copy,
  DownloadSimple as Download,
  Eye,
  EyeSlash as EyeOff,
  FileText,
  Keyboard,
  Lock,
  PaperPlaneTilt as Send,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Warning as AlertTriangle,
  XCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { findNextReviewUploadId, ReviewSheet, type ReviewDoc } from "@/components/review-sheet";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  apiJson,
  ApiError,
  formatBytes,
  formatRelativeTime,
  IS_DEMO,
  triggerDemoDownload,
  VALIDATOR_OPTIONS,
  type AuditEventDto,
  type ItemKind,
  type RequestDetailResponse,
  type RequestItemDto,
  type SessionResponse,
  type ValidatorKey,
} from "@/lib/api";

type ItemFilter = "all" | "submitted" | "rejected" | "approved" | "pending";

const MANUAL_COOLDOWN_MS = 15 * 60_000;

const QUICK_REJECTION_CHIPS = [
  "Blurry or unreadable scan",
  "Missing page or cut-off corners",
  "Wrong financial period or date",
  "Document is unsigned",
];

const FILE_GROUP_OPTIONS = [
  { key: "pdf", label: "PDF" },
  { key: "image", label: "Images" },
  { key: "spreadsheet", label: "CSV / XLSX" },
  { key: "document", label: "DOCX / TXT" },
];

const AUDIT_LABELS: Record<string, string> = {
  "request.created": "Checklist request created",
  "invite.sent": "Initial magic-link invite emailed",
  "otp.sent": "6-digit verification code emailed",
  "otp.verified": "Client verified email via OTP",
  "item.submitted": "Client submitted response",
  "item.files_uploaded": "Client uploaded encrypted document(s)",
  "item.file_removed": "Client removed uploaded file",
  "item.note_saved": "Client saved note on item",
  "item.marked_na": "Client marked item not applicable",
  "item.added": "Operator added checklist item",
  "item.approved": "Operator approved and locked item",
  "item.rejected": "Operator requested revision",
  "request.approved_all_submitted": "Operator batch-approved submitted items",
  "request.due_date_updated": "Operator updated due date",
  "item.sensitive_revealed": "Sensitive field revealed (audited)",
  "upload.previewed": "Operator previewed encrypted document",
  "upload.downloaded": "Operator downloaded decrypted document",
  "request.exported_zip": "Operator exported pack (.zip)",
  "reminder.sent": "Scheduled reminder email dispatched",
  "reminder.manual_sent": "Operator sent manual reminder",
  "reminders.paused": "Automated follow-ups paused",
  "reminders.resumed": "Automated follow-ups resumed",
  "webhook.dispatched": "Completion webhook delivered",
  "webhook.failed": "Completion webhook failed",
  "request.purged": "Expired pack shredded per retention policy",
};

const SHORTCUTS = [
  { keys: ["J", "K"], desc: "Move to next / previous item (or step documents in preview)" },
  { keys: ["Space"], desc: "Open document preview for selected item" },
  { keys: ["A"], desc: "Approve & lock selected submitted item" },
  { keys: ["R"], desc: "Request revision on selected item" },
  { keys: ["Esc"], desc: "Close overlay or clear item selection" },
  { keys: ["?"], desc: "Show or hide keyboard shortcuts" },
  { keys: ["C"], desc: "Create a new checklist request" },
  { keys: ["Ctrl K"], desc: "Open quick jump command palette" },
];

function canInlinePreview(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime === "text/csv" ||
    mime === "text/plain"
  );
}

function computeOptimisticRequestStatus(
  items: RequestItemDto[],
  currentStatus: RequestDetailResponse["request"]["status"]
): RequestDetailResponse["request"]["status"] {
  if (currentStatus === "purged" || currentStatus === "expired") return currentStatus;
  const requiredItems = items.filter((i) => i.required);
  const checkSet = requiredItems.length > 0 ? requiredItems : items;
  const allApproved = checkSet.length > 0 && checkSet.every((i) => i.status === "approved");
  const allSubmittedOrApproved =
    checkSet.length > 0 &&
    checkSet.every((i) => i.status === "submitted" || i.status === "approved");
  const hasRejected = items.some((i) => i.status === "rejected");
  if (allApproved) return "completed";
  if (allSubmittedOrApproved && !hasRejected) return "in_review";
  return "open";
}

export function RequestDetailPage({
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
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<RequestDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [compact, setCompact] = useState(false);
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [batchApproving, setBatchApproving] = useState(false);

  // Keyboard triage & continuous review
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [previewUploadId, setPreviewUploadId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const itemCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const inFlightReviewsRef = useRef(0);

  // Revision modal state
  const [reviseTarget, setReviseTarget] = useState<RequestItemDto | null>(null);
  const [reviseNote, setReviseNote] = useState("");
  const [reviseSubmitting, setReviseSubmitting] = useState(false);
  const [resumeReviewAfterRevision, setResumeReviewAfterRevision] = useState(false);

  // Live controls: manual nudge, due date, add item
  const [reminding, setReminding] = useState(false);
  const [duePopoverOpen, setDuePopoverOpen] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState("");
  const [savingDue, setSavingDue] = useState(false);

  const [addItemOpen, setAddItemOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newSection, setNewSection] = useState("Additional Items");
  const [newKind, setNewKind] = useState<ItemKind>("file");
  const [newValidator, setNewValidator] = useState<ValidatorKey>("none");
  const [newAllowedGroups, setNewAllowedGroups] = useState<string[]>(["pdf", "image"]);
  const [newMultiple, setNewMultiple] = useState(false);
  const [newRequired, setNewRequired] = useState(true);
  const [newHelpText, setNewHelpText] = useState("");
  const [addingItem, setAddingItem] = useState(false);

  const loadDetail = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!id) return;
      try {
        const res = await apiJson<RequestDetailResponse>(`/api/requests/${id}`);
        setData(res);
      } catch {
        if (!opts?.silent) toast.error("Request not found.");
      } finally {
        setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const sections = useMemo(() => {
    if (!data) return [];
    const filtered = data.items.filter((it) => filter === "all" || it.status === filter);
    const groups = new Map<string, RequestItemDto[]>();
    for (const item of filtered) {
      const arr = groups.get(item.section) ?? [];
      arr.push(item);
      groups.set(item.section, arr);
    }
    return [...groups.entries()];
  }, [data, filter]);

  const visibleItems = useMemo(() => sections.flatMap(([, items]) => items), [sections]);

  const reviewDocs = useMemo<ReviewDoc[]>(() => {
    if (!data) return [];
    const out: ReviewDoc[] = [];
    for (const item of data.items) {
      for (const upload of item.uploads) {
        if (canInlinePreview(upload.detected_mime)) {
          out.push({ item, upload });
        }
      }
    }
    return out;
  }, [data]);

  const submittedCount = useMemo(
    () => data?.items.filter((i) => i.status === "submitted").length ?? 0,
    [data]
  );

  const outstandingCount = useMemo(
    () =>
      data?.items.filter(
        (i) => (i.required || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
      ).length ?? 0,
    [data]
  );

  const handleReview = useCallback(
    async (
      item: RequestItemDto,
      decision: "approved" | "rejected",
      note?: string,
      opts?: { fromPreview?: boolean; nextPreviewUploadId?: string | null }
    ) => {
      if (!id) return;
      const prevStatus = item.status;
      const prevNote = item.review_note;

      setData((cur) => {
        if (!cur) return cur;
        const nextItems = cur.items.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: decision,
                review_note:
                  decision === "rejected" ? (note || "Please review and re-upload.").trim() : null,
              }
            : it
        );
        return {
          ...cur,
          request: {
            ...cur.request,
            status: computeOptimisticRequestStatus(nextItems, cur.request.status),
          },
          items: nextItems,
        };
      });

      if (opts?.fromPreview) {
        setPreviewUploadId(opts.nextPreviewUploadId ?? null);
      }

      inFlightReviewsRef.current += 1;
      try {
        const res = await apiJson<{ ok: boolean; justCompleted: boolean }>(
          `/api/requests/${id}/items/${item.id}/review`,
          {
            method: "POST",
            body: JSON.stringify({ decision, note }),
          }
        );
        if (decision === "approved") {
          toast.success(
            res.justCompleted ? "Pack completed and webhook notified." : `Approved "${item.label}".`
          );
        } else {
          toast.success("Revision requested and client emailed.");
        }
      } catch (err) {
        setData((cur) => {
          if (!cur) return cur;
          const revertedItems = cur.items.map((it) =>
            it.id === item.id ? { ...it, status: prevStatus, review_note: prevNote } : it
          );
          return {
            ...cur,
            request: {
              ...cur.request,
              status: computeOptimisticRequestStatus(revertedItems, cur.request.status),
            },
            items: revertedItems,
          };
        });
        toast.error(
          err instanceof ApiError ? err.message : "Could not save review. Changes reverted."
        );
      } finally {
        inFlightReviewsRef.current -= 1;
        if (inFlightReviewsRef.current === 0) {
          void loadDetail({ silent: true });
        }
      }
    },
    [id, loadDetail]
  );

  // Keyboard-first triage across list and continuous document preview
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping) return;

      const modalOpen =
        Boolean(reviseTarget) ||
        addItemOpen ||
        duePopoverOpen ||
        Boolean(document.querySelector('[data-slot="dialog-content"]'));

      if (e.key === "?") {
        if (shortcutsOpen || !modalOpen) {
          e.preventDefault();
          setShortcutsOpen((o) => !o);
        }
        return;
      }

      if (modalOpen) return;

      const key = e.key.toLowerCase();

      if (previewUploadId) {
        const idx = reviewDocs.findIndex((d) => d.upload.id === previewUploadId);
        if (idx < 0) return;
        const current = reviewDocs[idx];

        if (key === "j" || e.key === "ArrowRight") {
          if (idx < reviewDocs.length - 1) {
            e.preventDefault();
            setPreviewUploadId(reviewDocs[idx + 1].upload.id);
          }
          return;
        }
        if (key === "k" || e.key === "ArrowLeft") {
          if (idx > 0) {
            e.preventDefault();
            setPreviewUploadId(reviewDocs[idx - 1].upload.id);
          }
          return;
        }
        if (key === "a") {
          if (data?.request.status !== "purged" && current.item.status === "submitted") {
            e.preventDefault();
            const nextId = findNextReviewUploadId(reviewDocs, idx);
            void handleReview(current.item, "approved", undefined, {
              fromPreview: true,
              nextPreviewUploadId: nextId,
            });
          }
          return;
        }
        if (key === "r") {
          if (data?.request.status !== "purged" && current.item.status !== "pending") {
            e.preventDefault();
            setResumeReviewAfterRevision(true);
            setReviseTarget(current.item);
            setReviseNote(current.item.review_note || "");
          }
        }
        return;
      }

      if (visibleItems.length === 0) return;

      if (key === "j") {
        e.preventDefault();
        const idx = visibleItems.findIndex((i) => i.id === activeItemId);
        const nextIdx = idx < 0 ? 0 : Math.min(visibleItems.length - 1, idx + 1);
        const nextId = visibleItems[nextIdx].id;
        setActiveItemId(nextId);
        itemCardRefs.current[nextId]?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (key === "k") {
        e.preventDefault();
        const idx = visibleItems.findIndex((i) => i.id === activeItemId);
        const prevIdx = idx < 0 ? visibleItems.length - 1 : Math.max(0, idx - 1);
        const prevId = visibleItems[prevIdx].id;
        setActiveItemId(prevId);
        itemCardRefs.current[prevId]?.scrollIntoView({ block: "nearest" });
        return;
      }

      const activeItem = visibleItems.find((i) => i.id === activeItemId);
      if (!activeItem) return;

      if (e.key === " ") {
        if (
          target?.closest(
            'button, a, input, textarea, select, [role="button"], [role="switch"], [role="tab"], [role="checkbox"], [role="menuitem"]'
          )
        ) {
          return;
        }
        const firstPreview = activeItem.uploads.find((u) => canInlinePreview(u.detected_mime));
        if (firstPreview) {
          e.preventDefault();
          setPreviewUploadId(firstPreview.id);
        }
        return;
      }

      if (key === "a") {
        if (data?.request.status !== "purged" && activeItem.status === "submitted") {
          e.preventDefault();
          void handleReview(activeItem, "approved");
        }
        return;
      }

      if (key === "r") {
        if (data?.request.status !== "purged" && activeItem.status !== "pending") {
          e.preventDefault();
          setResumeReviewAfterRevision(false);
          setReviseTarget(activeItem);
          setReviseNote(activeItem.review_note || "");
        }
        return;
      }

      if (e.key === "Escape" && activeItemId) {
        setActiveItemId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeItemId,
    addItemOpen,
    data?.request.status,
    duePopoverOpen,
    handleReview,
    previewUploadId,
    reviewDocs,
    reviseTarget,
    shortcutsOpen,
    visibleItems,
  ]);

  async function handleReveal(itemId: string) {
    if (!id) return;
    if (revealedValues[itemId]) {
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      return;
    }
    try {
      const res = await apiJson<{ value: string }>(`/api/requests/${id}/items/${itemId}/reveal`, {
        method: "POST",
      });
      setRevealedValues((prev) => ({ ...prev, [itemId]: res.value }));
      toast.info("Sensitive value revealed and recorded in audit trail.");
      await loadDetail({ silent: true });
    } catch {
      toast.error("Failed to reveal field.");
    }
  }

  async function handleApproveAllSubmitted() {
    if (!id) return;
    setBatchApproving(true);
    try {
      const res = await apiJson<{ approvedCount: number; justCompleted: boolean }>(
        `/api/requests/${id}/approve-all-submitted`,
        { method: "POST" }
      );
      toast.success(
        res.justCompleted
          ? `Approved ${res.approvedCount} items. Checklist complete.`
          : `Approved ${res.approvedCount} submitted items.`
      );
      await loadDetail({ silent: true });
    } catch {
      toast.error("Batch approve failed.");
    } finally {
      setBatchApproving(false);
    }
  }

  async function handleToggleReminders() {
    if (!id || !data) return;
    const prevPaused = data.request.reminders_paused;
    setData((cur) =>
      cur ? { ...cur, request: { ...cur.request, reminders_paused: !prevPaused } } : cur
    );
    try {
      const res = await apiJson<{ reminders_paused: boolean }>(
        `/api/requests/${id}/toggle-reminders`,
        { method: "POST" }
      );
      toast.success(
        res.reminders_paused ? "Follow-up reminders paused." : "Follow-up reminders resumed."
      );
      void loadDetail({ silent: true });
    } catch (err) {
      setData((cur) =>
        cur ? { ...cur, request: { ...cur.request, reminders_paused: prevPaused } } : cur
      );
      toast.error(
        err instanceof ApiError ? err.message : "Could not update reminders. Changes reverted."
      );
    }
  }

  async function handleRemindNow() {
    if (!id) return;
    setReminding(true);
    try {
      const res = await apiJson<{
        reminders_sent: number;
        last_manual_reminder_at: string;
        next_reminder_at: string | null;
      }>(`/api/requests/${id}/remind-now`, { method: "POST" });
      setData((cur) =>
        cur
          ? {
              ...cur,
              request: {
                ...cur.request,
                reminders_sent: res.reminders_sent,
                last_manual_reminder_at: res.last_manual_reminder_at,
                next_reminder_at: res.next_reminder_at,
              },
            }
          : cur
      );
      toast.success("Reminder email sent to client.");
      void loadDetail({ silent: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send reminder.");
      if (err instanceof ApiError && err.status === 429) {
        void loadDetail({ silent: true });
      }
    } finally {
      setReminding(false);
    }
  }

  async function handleSaveDueDate(nextDateStr: string) {
    if (!id || !data) return;
    const prevDue = data.request.due_at;
    const iso = nextDateStr ? new Date(`${nextDateStr}T17:00:00Z`).toISOString() : null;
    setSavingDue(true);
    setDuePopoverOpen(false);
    setData((cur) => (cur ? { ...cur, request: { ...cur.request, due_at: iso } } : cur));
    try {
      await apiJson(`/api/requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ dueAt: iso }),
      });
      toast.success(iso ? "Due date updated." : "Due date cleared.");
      void loadDetail({ silent: true });
    } catch (err) {
      setData((cur) => (cur ? { ...cur, request: { ...cur.request, due_at: prevDue } } : cur));
      toast.error(
        err instanceof ApiError ? err.message : "Could not update due date. Changes reverted."
      );
    } finally {
      setSavingDue(false);
    }
  }

  async function handleAddItem(e: FormEvent) {
    e.preventDefault();
    if (!id || !newLabel.trim()) {
      toast.error("Enter an item label.");
      return;
    }
    setAddingItem(true);
    try {
      await apiJson(`/api/requests/${id}/items`, {
        method: "POST",
        body: JSON.stringify({
          label: newLabel.trim(),
          section: newSection.trim() || "Additional Items",
          kind: newKind,
          required: newRequired,
          validator: newKind === "text" || newKind === "textarea" ? newValidator : "none",
          allowedGroups: newKind === "file" ? newAllowedGroups : undefined,
          multiple: newKind === "file" ? newMultiple : false,
          helpText: newHelpText.trim(),
        }),
      });
      toast.success("Checklist item added.");
      setAddItemOpen(false);
      setNewLabel("");
      setNewHelpText("");
      setNewKind("file");
      setNewValidator("none");
      setNewAllowedGroups(["pdf", "image"]);
      setNewMultiple(false);
      setNewRequired(true);
      await loadDetail({ silent: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add item.");
    } finally {
      setAddingItem(false);
    }
  }

  async function submitRevisionDialog() {
    if (!reviseTarget) return;
    if (!reviseNote.trim()) {
      toast.error("Enter a brief explanation for the client.");
      return;
    }
    setReviseSubmitting(true);
    try {
      let nextPreviewUploadId: string | null = null;
      if (resumeReviewAfterRevision) {
        const idx = previewUploadId
          ? reviewDocs.findIndex((d) => d.upload.id === previewUploadId)
          : reviewDocs.findIndex((d) => d.item.id === reviseTarget.id);
        nextPreviewUploadId = idx >= 0 ? findNextReviewUploadId(reviewDocs, idx) : null;
      }
      await handleReview(reviseTarget, "rejected", reviseNote.trim(), {
        fromPreview: resumeReviewAfterRevision,
        nextPreviewUploadId,
      });
      setReviseTarget(null);
      setReviseNote("");
      setResumeReviewAfterRevision(false);
    } finally {
      setReviseSubmitting(false);
    }
  }

  if (loading || !data) {
    return (
      <AppShell
        session={session}
        breadcrumbs={[{ label: "Requests", to: "/" }, { label: "Loading..." }]}
        onSessionRefresh={onSessionRefresh}
        theme={theme}
        onToggleTheme={onToggleTheme}
      >
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-4 w-96" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-8 w-36" />
            </div>
          </div>
          <Skeleton className="h-16 w-full rounded-xl" />
          <div className="space-y-3">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  const { request } = data;
  const validatorLabel = (key: string) =>
    VALIDATOR_OPTIONS.find((v) => v.value === key)?.short ?? key;
  const isEditableRequest = request.status === "open" || request.status === "in_review";
  const inCooldown = Boolean(
    request.last_manual_reminder_at &&
      Date.now() - Date.parse(request.last_manual_reminder_at) < MANUAL_COOLDOWN_MS
  );

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Requests", to: "/" }, { label: request.title }]}
      onSessionRefresh={onSessionRefresh}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        {/* Header & Primary Controls */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {request.title}
              </h1>
              <StatusBadge status={request.status} />
              {request.require_otp && (
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                >
                  <ShieldCheck className="size-3" />
                  Email OTP gated
                </Badge>
              )}
              {request.is_demo && <Badge variant="secondary">Sample pack</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground tabular-nums">
              <span>
                <strong className="font-medium text-foreground">{request.client_name}</strong> (
                {request.client_email})
              </span>
              <span>· Chaser: {request.reminders_sent}/{request.max_reminders} sent</span>
              {request.reminders_paused && (
                <span className="text-amber-700 dark:text-amber-300">· Paused</span>
              )}
              {isEditableRequest ? (
                <>
                  <span>·</span>
                  <Popover
                    open={duePopoverOpen}
                    onOpenChange={(open) => {
                      setDuePopoverOpen(open);
                      if (open) setDueDateDraft(request.due_at ? request.due_at.slice(0, 10) : "");
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground underline-offset-4 hover:bg-muted hover:underline"
                      >
                        <Calendar className="size-3 text-muted-foreground" />
                        {request.due_at ? `Due ${request.due_at.slice(0, 10)}` : "Set due date"}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 space-y-3 p-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-due-date" className="text-xs">
                          Target due date
                        </Label>
                        <Input
                          id="edit-due-date"
                          type="date"
                          value={dueDateDraft}
                          onChange={(e) => setDueDateDraft(e.target.value)}
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        {request.due_at && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={savingDue}
                            onClick={() => void handleSaveDueDate("")}
                          >
                            Clear
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="xs"
                          disabled={savingDue || !dueDateDraft}
                          onClick={() => void handleSaveDueDate(dueDateDraft)}
                        >
                          Save
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </>
              ) : (
                request.due_at && <span>· Due {request.due_at.slice(0, 10)}</span>
              )}
              {request.purge_at && <span>· Auto-purge {request.purge_at.slice(0, 10)}</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {request.status !== "purged" && submittedCount > 0 && (
              <Button onClick={handleApproveAllSubmitted} disabled={batchApproving} size="sm">
                <CheckCheck className="mr-1.5 size-4" />
                {batchApproving ? "Approving..." : `Approve all submitted (${submittedCount})`}
              </Button>
            )}
            {request.status !== "purged" && (
              IS_DEMO ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void triggerDemoDownload("export", request.id)}
                >
                  <Download className="mr-1.5 size-4" />
                  Download Pack (.zip)
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/requests/${request.id}/export.zip`}>
                    <Download className="mr-1.5 size-4" />
                    Download Pack (.zip)
                  </a>
                </Button>
              )
            )}
            {request.status === "open" && outstandingCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemindNow}
                disabled={reminding || inCooldown}
              >
                <Send className="mr-1.5 size-3.5" />
                {reminding
                  ? "Sending..."
                  : inCooldown
                    ? "Reminder sent recently"
                    : "Send reminder now"}
              </Button>
            )}
            {isEditableRequest && (
              <Button variant="outline" size="sm" onClick={handleToggleReminders}>
                {request.reminders_paused ? (
                  <>
                    <Play className="mr-1.5 size-3.5" />
                    Resume chaser
                  </>
                ) : (
                  <>
                    <Pause className="mr-1.5 size-3.5" />
                    Pause chaser
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Compact Magic Link Bar */}
        <Card className="paper-shadow">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Passwordless client magic link
              </p>
              <code className="mt-0.5 block truncate font-mono text-xs text-primary">
                {data.portalUrl}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(data.portalUrl);
                  toast.success("Magic link copied.");
                }}
              >
                <Copy className="mr-1.5 size-3.5" />
                Copy link
              </Button>
              <Button asChild size="sm" variant="secondary">
                <a href={data.portalUrl} target="_blank" rel="noopener noreferrer">
                  Preview as client
                  <ExternalLink className="ml-1.5 size-3.5" />
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Tabs: Checklist Items vs Audit Timeline */}
        <Tabs defaultValue="checklist" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="checklist">
                Checklist Items ({data.items.length})
              </TabsTrigger>
              <TabsTrigger value="audit">
                <History className="mr-1.5 size-3.5" />
                Audit Timeline ({data.auditEvents.length})
              </TabsTrigger>
            </TabsList>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 text-xs">
                {(
                  [
                    ["all", "All"],
                    ["submitted", "To review"],
                    ["rejected", "Needs revision"],
                    ["approved", "Locked"],
                    ["pending", "Pending"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                      filter === key
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch id="compact-mode" checked={compact} onCheckedChange={setCompact} />
                <Label htmlFor="compact-mode" className="cursor-pointer text-xs font-normal">
                  Compact view
                </Label>
              </div>
              {isEditableRequest && (
                <Button size="sm" variant="outline" onClick={() => setAddItemOpen(true)}>
                  <Plus className="mr-1 size-3.5" />
                  Add item
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 text-xs text-muted-foreground"
                onClick={() => setShortcutsOpen(true)}
              >
                <Keyboard className="size-3.5" />
                <span className="hidden sm:inline">Shortcuts</span>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  ?
                </kbd>
              </Button>
            </div>
          </div>

          <TabsContent value="checklist" className="space-y-6">
            {sections.length === 0 ? (
              <Card className="paper-shadow p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No checklist items match this status filter.
                </p>
                {filter !== "all" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    onClick={() => setFilter("all")}
                  >
                    Show all items
                  </Button>
                )}
              </Card>
            ) : (
              sections.map(([sectionName, sectionItems]) => (
                <div key={sectionName} className="space-y-3">
                  <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">
                    {sectionName}
                  </h2>
                  <div className="space-y-3">
                    {sectionItems.map((item) => {
                      const revealed = revealedValues[item.id];
                      const shownValue = revealed ?? item.displayValue;
                      const isLocked = item.status === "approved";
                      const isSelected = activeItemId === item.id;

                      return (
                        <Card
                          key={item.id}
                          ref={(el) => {
                            itemCardRefs.current[item.id] = el;
                          }}
                          data-item-id={item.id}
                          data-selected={isSelected ? "true" : undefined}
                          onClick={() => setActiveItemId(item.id)}
                          className={`paper-shadow transition-colors ${
                            isLocked
                              ? "border-emerald-200/90 bg-emerald-50/35 dark:border-emerald-900/50 dark:bg-emerald-950/15"
                              : item.status === "rejected"
                                ? "border-amber-300 bg-amber-50/30 dark:border-amber-800/60 dark:bg-amber-950/15"
                                : ""
                          } ${isSelected ? "border-primary/60 ring-2 ring-primary/50" : ""}`}
                        >
                          <CardContent className={compact ? "py-3.5" : "py-5"}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium text-foreground">
                                    {item.label}
                                    {item.required && <span className="ml-1 text-destructive">*</span>}
                                  </span>
                                  {item.validator !== "none" && (
                                    <Badge variant="secondary" className="text-[11px] font-normal">
                                      {validatorLabel(item.validator)}
                                    </Badge>
                                  )}
                                </div>
                                {!compact && item.help_text && (
                                  <p className="text-xs text-muted-foreground">{item.help_text}</p>
                                )}
                              </div>
                              <StatusBadge status={item.status} />
                            </div>

                            {shownValue && (
                              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                                <code className="font-mono text-xs font-medium text-foreground">
                                  {shownValue}
                                </code>
                                {item.isSensitiveMasked && (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    className="h-7 gap-1 text-xs"
                                    onClick={() => handleReveal(item.id)}
                                  >
                                    {revealed ? (
                                      <>
                                        <EyeOff className="size-3" />
                                        Hide
                                      </>
                                    ) : (
                                      <>
                                        <Eye className="size-3" />
                                        Reveal value (logged)
                                      </>
                                    )}
                                  </Button>
                                )}
                              </div>
                            )}

                            {item.uploads.length > 0 && (
                              <ul className="mt-3 space-y-2">
                                {item.uploads.map((u) => (
                                  <li
                                    key={u.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                                  >
                                    <div className="flex min-w-0 items-center gap-2.5">
                                      <FileText className="size-4 shrink-0 text-primary" />
                                      <div className="min-w-0">
                                        <p className="truncate font-mono font-medium text-foreground">
                                          {u.canonical_name}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground tabular-nums">
                                          {u.original_name} · {u.detected_mime} · {formatBytes(u.size_bytes)}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      {u.sha256 && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <Badge
                                              variant="outline"
                                              className="hidden cursor-help font-mono text-[10px] sm:inline-flex"
                                            >
                                              SHA-256
                                            </Badge>
                                          </TooltipTrigger>
                                          <TooltipContent className="font-mono text-[11px]">
                                            {u.sha256}
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                      {canInlinePreview(u.detected_mime) && (
                                        <Button
                                          size="xs"
                                          variant="secondary"
                                          className="h-7 gap-1 text-xs"
                                          onClick={() => {
                                            setActiveItemId(item.id);
                                            setPreviewUploadId(u.id);
                                          }}
                                        >
                                          <Eye className="size-3" />
                                          Preview
                                        </Button>
                                      )}
                                      {IS_DEMO ? (
                                        <Button
                                          type="button"
                                          size="xs"
                                          variant="outline"
                                          className="h-7 gap-1 text-xs"
                                          onClick={() => void triggerDemoDownload("upload", u.id)}
                                        >
                                          <Download className="size-3" />
                                          Download
                                        </Button>
                                      ) : (
                                        <Button asChild size="xs" variant="outline" className="h-7 gap-1 text-xs">
                                          <a href={`/api/uploads/${u.id}/download`}>
                                            <Download className="size-3" />
                                            Download
                                          </a>
                                        </Button>
                                      )}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}

                            {(item.client_na || item.client_note) && (
                              <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                                <span className="font-medium text-foreground">
                                  {item.client_na ? "Client says this doesn't apply:" : "Client note:"}
                                </span>{" "}
                                <span className="whitespace-pre-line text-muted-foreground">
                                  {item.client_note}
                                </span>
                              </div>
                            )}

                            {item.review_note && (
                              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                <span>
                                  <strong>Revision feedback sent to client:</strong> {item.review_note}
                                </span>
                              </div>
                            )}

                            {request.status !== "purged" && item.status !== "pending" && (
                              <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-3">
                                {item.status !== "approved" && (
                                  <Button
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs"
                                    onClick={() => void handleReview(item, "approved")}
                                  >
                                    <Lock className="size-3.5" />
                                    Approve & lock
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 gap-1.5 text-xs text-amber-800 hover:bg-amber-50 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                                  onClick={() => {
                                    setResumeReviewAfterRevision(false);
                                    setReviseTarget(item);
                                    setReviseNote(item.review_note || "");
                                  }}
                                >
                                  <XCircle className="size-3.5" />
                                  Request revision
                                </Button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="audit">
            <Card className="paper-shadow">
              <CardContent className="divide-y divide-border p-0">
                {data.auditEvents.map((ev: AuditEventDto) => {
                  const meta = (() => {
                    try {
                      return JSON.parse(ev.meta_json) as Record<string, unknown>;
                    } catch {
                      return {};
                    }
                  })();
                  const detailStr = Object.entries(meta)
                    .filter(([, v]) => v !== undefined && v !== "")
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ");

                  return (
                    <div
                      key={ev.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-xs"
                    >
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="w-16 justify-center text-[11px] capitalize">
                          {ev.actor}
                        </Badge>
                        <div>
                          <p className="font-medium text-foreground">
                            {AUDIT_LABELS[ev.action] || ev.action}
                          </p>
                          {detailStr && (
                            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                              {detailStr}
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {formatRelativeTime(ev.created_at)} · {ev.created_at.replace("T", " ").slice(0, 19)}Z
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <ReviewSheet
        docs={reviewDocs}
        activeUploadId={previewUploadId}
        requestStatus={request.status}
        onSelectUpload={setPreviewUploadId}
        onApproveAndNext={(item, nextUploadId) =>
          void handleReview(item, "approved", undefined, {
            fromPreview: true,
            nextPreviewUploadId: nextUploadId,
          })
        }
        onRequestRevision={(item) => {
          setResumeReviewAfterRevision(true);
          setReviseTarget(item);
          setReviseNote(item.review_note || "");
        }}
      />

      {/* Request Revision Modal */}
      <Dialog
        open={Boolean(reviseTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setReviseTarget(null);
            setResumeReviewAfterRevision(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request revision</DialogTitle>
            <DialogDescription>
              Explain what needs updating for <strong>{reviseTarget?.label}</strong>. GatherGate emails{" "}
              {request.client_email} with their magic link.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {QUICK_REJECTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setReviseNote(chip)}
                  className="rounded-md border border-border bg-muted/60 px-2.5 py-1 text-xs text-foreground hover:border-primary/50 hover:bg-accent"
                >
                  {chip}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="revise-note">Client-facing note</Label>
              <Textarea
                id="revise-note"
                rows={3}
                placeholder="e.g. Page 2 is missing from the PDF scan."
                value={reviseNote}
                onChange={(e) => setReviseNote(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReviseTarget(null);
                setResumeReviewAfterRevision(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={submitRevisionDialog} disabled={reviseSubmitting}>
              {reviseSubmitting ? "Sending..." : "Send revision request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Item Dialog */}
      <Dialog open={addItemOpen} onOpenChange={setAddItemOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add checklist item</DialogTitle>
            <DialogDescription>
              Append a new requirement directly to this live checklist. The client sees it immediately on their link.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAddItem} className="space-y-3.5 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="add-item-label">Item label</Label>
              <Input
                id="add-item-label"
                required
                placeholder="e.g. Supplier Invoice Photo"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="add-item-section">Section</Label>
                <Input
                  id="add-item-section"
                  value={newSection}
                  onChange={(e) => setNewSection(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-item-kind">Field type</Label>
                <Select
                  value={newKind}
                  onValueChange={(v) => {
                    const nextKind = v as ItemKind;
                    setNewKind(nextKind);
                    if (nextKind === "file" || nextKind === "checkbox") setNewValidator("none");
                  }}
                >
                  <SelectTrigger id="add-item-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="file">File upload</SelectItem>
                    <SelectItem value="text">Short text / ID</SelectItem>
                    <SelectItem value="textarea">Long text notes</SelectItem>
                    <SelectItem value="checkbox">Declaration checkbox</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(newKind === "text" || newKind === "textarea") && (
              <div className="space-y-1.5">
                <Label htmlFor="add-item-validator">Validator</Label>
                <Select value={newValidator} onValueChange={setNewValidator}>
                  <SelectTrigger id="add-item-validator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VALIDATOR_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {newKind === "file" && (
              <div className="space-y-2">
                <Label className="text-xs">Allowed file types</Label>
                <div className="flex flex-wrap gap-1.5">
                  {FILE_GROUP_OPTIONS.map((g) => {
                    const active = newAllowedGroups.includes(g.key);
                    return (
                      <button
                        key={g.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setNewAllowedGroups((prev) => {
                            const next = prev.includes(g.key)
                              ? prev.filter((k) => k !== g.key)
                              : [...prev, g.key];
                            return next.length > 0 ? next : [g.key];
                          })
                        }
                        className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                          active
                            ? "border-primary bg-accent text-accent-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {g.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="add-item-help">Helper text (optional)</Label>
              <Input
                id="add-item-help"
                placeholder="Brief instructions shown to client"
                value={newHelpText}
                onChange={(e) => setNewHelpText(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-5 pt-1">
              <label htmlFor="add-item-required" className="flex items-center gap-2 text-xs text-foreground">
                <Switch
                  id="add-item-required"
                  checked={newRequired}
                  onCheckedChange={setNewRequired}
                />
                Required item
              </label>
              {newKind === "file" && (
                <label htmlFor="add-item-multiple" className="flex items-center gap-2 text-xs text-foreground">
                  <Switch
                    id="add-item-multiple"
                    checked={newMultiple}
                    onCheckedChange={setNewMultiple}
                  />
                  Allow multiple files
                </label>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setAddItemOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addingItem}>
                {addingItem ? "Adding..." : "Add to checklist"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Keyboard Shortcut Cheat-Sheet */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Triage uploaded items and documents without leaving the keyboard.
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-y divide-border text-xs">
            {SHORTCUTS.map((s) => (
              <li key={s.desc} className="flex items-center justify-between gap-4 py-2.5">
                <span className="text-muted-foreground">{s.desc}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
