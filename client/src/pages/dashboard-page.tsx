import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowsDownUp as ArrowUpDown,
  ArrowSquareOut as ExternalLink,
  Copy,
  DotsThree as MoreHorizontal,
  DownloadSimple as Download,
  FolderOpen,
  MagnifyingGlass as Search,
  Pause,
  Play,
  Plus,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  apiJson,
  ApiError,
  formatBytes,
  formatRelativeTime,
  IS_DEMO,
  triggerDemoDownload,
  type RequestSummaryDto,
  type RequestsListResponse,
  type SessionResponse,
} from "@/lib/api";
import { copyText } from "@/lib/utils";

function demoPortalPath(url: string): string {
  const hashIdx = url.indexOf("#/c/");
  if (hashIdx >= 0) return url.slice(hashIdx + 1);
  const pathIdx = url.indexOf("/c/");
  return pathIdx >= 0 ? url.slice(pathIdx) : "/";
}

type FilterTab = "all" | "active" | "awaiting_review" | "needs_revision" | "completed" | "purged";

function isActiveRequest(r: RequestSummaryDto): boolean {
  return r.status === "open" || r.status === "in_review";
}

export function DashboardPage({
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
  const [data, setData] = useState<RequestsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [seeding, setSeeding] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const loadRequests = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const res = await apiJson<RequestsListResponse>("/api/requests");
      setData(res);
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const valid = new Set(res.requests.filter(isActiveRequest).map((r) => r.id));
        const next = new Set([...prev].filter((id) => valid.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch {
      if (!opts?.silent) toast.error("Failed to load intake requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  async function handleSeedDemo() {
    setSeeding(true);
    try {
      await apiJson("/api/demo/seed", { method: "POST" });
      toast.success("Loaded 3 sample client packs.");
      await onSessionRefresh();
      await loadRequests({ silent: true });
    } catch {
      toast.error("Could not load sample workspace.");
    } finally {
      setSeeding(false);
    }
  }

  async function handleCopyLink(url: string) {
    const ok = await copyText(url);
    if (ok) toast.success("Magic link copied to clipboard.");
    else toast.error("Could not copy magic link.");
  }

  const handleBulkReminders = useCallback(
    async (ids: string[], paused: boolean) => {
      if (ids.length === 0 || !data) return;
      const targetSet = new Set(ids);
      const prevMap = new Map<string, boolean>();
      for (const req of data.requests) {
        if (targetSet.has(req.id) && isActiveRequest(req)) {
          prevMap.set(req.id, req.reminders_paused);
        }
      }
      if (prevMap.size === 0) return;

      setSelectedIds(new Set());
      setData((cur) =>
        cur
          ? {
              ...cur,
              requests: cur.requests.map((r) =>
                prevMap.has(r.id) ? { ...r, reminders_paused: paused } : r
              ),
            }
          : cur
      );

      try {
        await apiJson<{ ok: boolean; updatedIds: string[]; paused: boolean }>(
          "/api/requests/bulk-reminders",
          {
            method: "POST",
            body: JSON.stringify({ ids: [...prevMap.keys()], paused }),
          }
        );
        toast.success(paused ? "Reminders paused." : "Reminders resumed.");
        void loadRequests({ silent: true });
      } catch (err) {
        setData((cur) =>
          cur
            ? {
                ...cur,
                requests: cur.requests.map((r) =>
                  prevMap.has(r.id) ? { ...r, reminders_paused: prevMap.get(r.id)! } : r
                ),
              }
            : cur
        );
        toast.error(
          err instanceof ApiError ? err.message : "Could not update reminders. Changes reverted."
        );
      }
    },
    [data, loadRequests]
  );

  const filteredRequests = useMemo(() => {
    const list = data?.requests ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((r) => {
      if (tab === "active" && !isActiveRequest(r)) return false;
      if (tab === "awaiting_review" && !(r.submitted_items > 0 && r.status !== "purged")) return false;
      if (tab === "needs_revision" && !(r.rejected_items > 0 && r.status !== "purged")) return false;
      if (tab === "completed" && r.status !== "completed") return false;
      if (tab === "purged" && r.status !== "purged") return false;

      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.client_name.toLowerCase().includes(q) ||
        r.client_email.toLowerCase().includes(q)
      );
    });
  }, [data, tab, search]);

  const tabCounts = useMemo(() => {
    const list = data?.requests ?? [];
    return {
      all: list.length,
      active: list.filter(isActiveRequest).length,
      awaiting_review: list.filter((r) => r.submitted_items > 0 && r.status !== "purged").length,
      needs_revision: list.filter((r) => r.rejected_items > 0 && r.status !== "purged").length,
      completed: list.filter((r) => r.status === "completed").length,
      purged: list.filter((r) => r.status === "purged").length,
    };
  }, [data]);

  const activeVisibleIds = useMemo(
    () => filteredRequests.filter(isActiveRequest).map((r) => r.id),
    [filteredRequests]
  );

  const allVisibleSelected =
    activeVisibleIds.length > 0 && activeVisibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected =
    !allVisibleSelected && activeVisibleIds.some((id) => selectedIds.has(id));

  const columns = useMemo<ColumnDef<RequestSummaryDto>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            aria-label="Select all active requests"
            disabled={activeVisibleIds.length === 0}
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={(checked) => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (checked === true) {
                  activeVisibleIds.forEach((id) => next.add(id));
                } else {
                  activeVisibleIds.forEach((id) => next.delete(id));
                }
                return next;
              });
            }}
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const active = isActiveRequest(r);
          return (
            <Checkbox
              aria-label={`Select ${r.title}`}
              disabled={!active}
              checked={selectedIds.has(r.id)}
              onCheckedChange={(checked) => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (checked === true) next.add(r.id);
                  else next.delete(r.id);
                  return next;
                });
              }}
            />
          );
        },
      },
      {
        accessorKey: "title",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Checklist
            <ArrowUpDown className="ml-1.5 size-3.5" />
          </Button>
        ),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="min-w-0 max-w-[260px]">
              <div className="flex items-center gap-2">
                <Link
                  to={`/requests/${r.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate font-medium text-foreground hover:text-primary hover:underline"
                >
                  {r.title}
                </Link>
                {r.is_demo && (
                  <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">
                    Demo
                  </Badge>
                )}
              </div>
              {(r.due_at || r.last_opened_at) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {r.due_at && (
                    <span className="tabular-nums">
                      Due{" "}
                      {new Date(r.due_at).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "short",
                        timeZone: "UTC",
                      })}
                    </span>
                  )}
                  {r.due_at && r.last_opened_at && <span aria-hidden="true">·</span>}
                  {r.last_opened_at && <span>Opened {formatRelativeTime(r.last_opened_at)}</span>}
                </div>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "client_name",
        header: "Client",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="min-w-0 max-w-[210px]">
              <div className="truncate font-medium text-foreground">{r.client_name}</div>
              <div className="truncate text-xs text-muted-foreground">{r.client_email}</div>
            </div>
          );
        },
      },
      {
        id: "progress",
        header: "Completion",
        cell: ({ row }) => {
          const r = row.original;
          const total = Math.max(1, r.total_items);
          const pct = Math.round((r.approved_items / total) * 100);
          return (
            <div className="w-32 space-y-1.5">
              <div className="flex items-center justify-between text-xs tabular-nums">
                <span className="font-medium text-foreground">
                  {r.approved_items}/{r.total_items} verified
                </span>
                <span className="text-muted-foreground">{pct}%</span>
              </div>
              <Progress aria-label={`${r.title} completion`} value={pct} className="h-1" />
              {(r.submitted_items > 0 || r.rejected_items > 0) && (
                <div className="flex gap-2.5 text-[11px] tabular-nums">
                  {r.submitted_items > 0 && (
                    <span className="text-blue-700 dark:text-blue-300">
                      {r.submitted_items} to review
                    </span>
                  )}
                  {r.rejected_items > 0 && (
                    <span className="text-amber-700 dark:text-amber-300">
                      {r.rejected_items} revision
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "chaser",
        header: "Follow-ups",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="text-xs tabular-nums text-muted-foreground">
              <div>
                {r.reminders_sent}/{r.max_reminders} sent
              </div>
              {r.reminders_paused && <span className="text-amber-700 dark:text-amber-300">Paused</span>}
            </div>
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const r = row.original;
          const actionLabel = r.submitted_items > 0 ? "Review" : "Open";
          const active = isActiveRequest(r);
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                size="sm"
                variant={r.submitted_items > 0 ? "outline" : "ghost"}
                className={
                  r.submitted_items > 0
                    ? "h-7 bg-card px-2.5 text-xs"
                    : "h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                }
                onClick={() => navigate(`/requests/${r.id}`)}
              >
                {actionLabel}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-foreground"
                title="Copy magic link"
                aria-label="Copy magic link"
                onClick={() => void handleCopyLink(r.portal_url)}
              >
                <Copy className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem asChild>
                    {IS_DEMO ? (
                      <Link to={demoPortalPath(r.portal_url)}>
                        <ExternalLink className="size-3.5" />
                        Open client portal
                      </Link>
                    ) : (
                      <a href={r.portal_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-3.5" />
                        Open client portal
                      </a>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleCopyLink(r.portal_url)}>
                    <Copy className="size-3.5" />
                    Copy magic link
                  </DropdownMenuItem>
                  {active && (
                    <DropdownMenuItem
                      onClick={() => void handleBulkReminders([r.id], !r.reminders_paused)}
                    >
                      {r.reminders_paused ? (
                        <>
                          <Play className="size-3.5" />
                          Resume reminders
                        </>
                      ) : (
                        <>
                          <Pause className="size-3.5" />
                          Pause reminders
                        </>
                      )}
                    </DropdownMenuItem>
                  )}
                  {r.status !== "purged" && (
                    <>
                      <DropdownMenuSeparator />
                      {IS_DEMO ? (
                        <DropdownMenuItem
                          onClick={() => void triggerDemoDownload("export", r.id)}
                        >
                          <Download className="size-3.5" />
                          Download pack (.zip)
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem asChild>
                          <a href={`/api/requests/${r.id}/export.zip`}>
                            <Download className="size-3.5" />
                            Download pack (.zip)
                          </a>
                        </DropdownMenuItem>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [activeVisibleIds, allVisibleSelected, handleBulkReminders, navigate, selectedIds, someVisibleSelected]
  );

  const table = useReactTable({
    data: filteredRequests,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const visibleRows = table.getRowModel().rows;

  useEffect(() => {
    if (!activeRowId) return;
    if (!visibleRows.some((r) => r.original.id === activeRowId)) {
      setActiveRowId(null);
    }
  }, [activeRowId, visibleRows]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (visibleRows.length === 0) return;

      const key = e.key.toLowerCase();
      const inInteractive = Boolean(
        target?.closest('a, button, [role="button"], [role="checkbox"], [role="menuitem"]')
      );
      if (key === "j" || (e.key === "ArrowDown" && !inInteractive)) {
        e.preventDefault();
        const idx = visibleRows.findIndex((r) => r.original.id === activeRowId);
        const nextIdx = idx < 0 ? 0 : Math.min(visibleRows.length - 1, idx + 1);
        const nextId = visibleRows[nextIdx].original.id;
        setActiveRowId(nextId);
        const el = rowRefs.current[nextId];
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest" });
        }
        return;
      }

      if (key === "k" || (e.key === "ArrowUp" && !inInteractive)) {
        e.preventDefault();
        const idx = visibleRows.findIndex((r) => r.original.id === activeRowId);
        const prevIdx = idx < 0 ? visibleRows.length - 1 : Math.max(0, idx - 1);
        const prevId = visibleRows[prevIdx].original.id;
        setActiveRowId(prevId);
        const el = rowRefs.current[prevId];
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest" });
        }
        return;
      }

      if (e.key === "Enter" && activeRowId) {
        if (target?.closest('a, button, [role="button"], [role="checkbox"], [role="menuitem"]')) {
          return;
        }
        e.preventDefault();
        navigate(`/requests/${activeRowId}`);
        return;
      }

      if (e.key === "Escape" && activeRowId) {
        e.preventDefault();
        setActiveRowId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRowId, navigate, visibleRows]);

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Intake Requests" }]}
      storageBytes={data?.storageBytes}
      demoPortalUrl={data?.demoPortalUrl}
      onSessionRefresh={onSessionRefresh}
      onDemoChanged={loadRequests}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              Intake Requests
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Track passwordless client submissions, verify statutory details, and dispatch automated follow-ups.
            </p>
          </div>
          {data && (
            <div className="text-xs text-muted-foreground tabular-nums">
              Vault storage: <strong className="font-medium text-foreground">{formatBytes(data.storageBytes)}</strong>
              {data.workspace.max_storage_bytes > 0
                ? ` / ${formatBytes(data.workspace.max_storage_bytes)}`
                : " · Self-hosted unlimited"}
            </div>
          )}
        </div>

        {/* 5-Column Segmented Metric & Filter Bar */}
        <div
          role="group"
          aria-label="Filter requests by status"
          className="paper-shadow grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-2 lg:grid-cols-5"
        >
          {[
            {
              label: "All",
              value: tabCounts.all,
              targetTab: "all" as FilterTab,
              dot: "bg-foreground/40",
            },
            {
              label: "Active",
              value: tabCounts.active,
              targetTab: "active" as FilterTab,
              dot: "bg-slate-400 dark:bg-slate-500",
            },
            {
              label: "Awaiting review",
              value: tabCounts.awaiting_review,
              targetTab: "awaiting_review" as FilterTab,
              dot: "bg-blue-600 dark:bg-blue-400",
            },
            {
              label: "Needs revision",
              value: tabCounts.needs_revision,
              targetTab: "needs_revision" as FilterTab,
              dot: "bg-amber-600 dark:bg-amber-400",
            },
            {
              label: "Completed",
              value: tabCounts.completed,
              targetTab: "completed" as FilterTab,
              dot: "bg-emerald-600 dark:bg-emerald-400",
            },
          ].map((kpi, idx) => {
            const isActive = tab === kpi.targetTab;
            return (
              <button
                key={kpi.targetTab}
                type="button"
                aria-pressed={isActive}
                onClick={() =>
                  setTab(kpi.targetTab === "all" ? "all" : isActive ? "all" : kpi.targetTab)
                }
                className={`relative flex w-full cursor-pointer flex-col border-border px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  idx > 0 ? "border-t sm:border-t-0" : ""
                } ${idx >= 2 ? "sm:border-t lg:border-t-0" : ""} ${
                  idx % 2 === 1 ? "sm:border-l lg:border-l-0" : ""
                } ${idx > 0 ? "lg:border-l" : ""} ${idx === 4 ? "sm:col-span-2 lg:col-span-1" : ""} ${
                  isActive ? "bg-muted/60" : ""
                }`}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${kpi.dot}`} />
                  {kpi.label}
                </span>
                <div className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">
                  {loading ? <Skeleton className="h-7 w-10" /> : kpi.value}
                </div>
                {isActive && (
                  <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
                )}
              </button>
            );
          })}
        </div>

        {/* Search + Purged Toggle + Keyboard Hint */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="Filter requests"
                placeholder="Filter by client, email, or checklist..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            {(tabCounts.purged > 0 || tab === "purged") && (
              <Button
                type="button"
                size="sm"
                variant={tab === "purged" ? "secondary" : "outline"}
                aria-pressed={tab === "purged"}
                onClick={() => setTab(tab === "purged" ? "all" : "purged")}
                className="h-9 gap-1.5 text-xs tabular-nums"
              >
                Purged ({tabCounts.purged})
              </Button>
            )}
          </div>
          {visibleRows.length > 0 && (
            <span className="hidden text-xs text-muted-foreground md:inline">
              J/K move · Enter open
            </span>
          )}
        </div>

        {/* Selection Toolbar */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
            <span className="font-medium text-foreground tabular-nums">
              {selectedIds.size} selected
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void handleBulkReminders([...selectedIds], true)}
              >
                <Pause className="mr-1 size-3" />
                Pause reminders
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void handleBulkReminders([...selectedIds], false)}
              >
                <Play className="mr-1 size-3" />
                Resume reminders
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* Table or Composed Empty State */}
        {loading ? (
          <Card className="paper-shadow gap-0 overflow-hidden py-0">
            <div className="border-b border-border bg-muted/50 px-4 py-3">
              <Skeleton className="h-4 w-48" />
            </div>
            <div className="divide-y divide-border">
              {[0, 1, 2, 3].map((rowIdx) => (
                <div key={rowIdx} className="flex items-center justify-between gap-4 px-4 py-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-4 rounded" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                  <Skeleton className="hidden h-4 w-32 sm:block" />
                  <Skeleton className="hidden h-3 w-28 md:block" />
                  <Skeleton className="h-5 w-20 rounded-md" />
                  <Skeleton className="h-7 w-16 rounded-md" />
                </div>
              ))}
            </div>
          </Card>
        ) : (data?.requests.length ?? 0) === 0 ? (
          <Card className="paper-shadow border-border bg-card">
            <CardContent className="flex flex-col items-center py-14 text-center">
              <div className="flex size-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <FolderOpen className="size-5" />
              </div>
              <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
                No active intake requests
              </h2>
              <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
                Send a structured document checklist with automated follow-ups and passwordless client access.
              </p>
              <Button asChild className="mt-6">
                <Link to="/requests/new">
                  <Plus className="mr-1.5 size-4" />
                  New request
                </Link>
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-2 text-xs text-muted-foreground"
                onClick={handleSeedDemo}
                disabled={seeding}
              >
                {seeding ? "Loading sample packs..." : "Load 3 sample packs"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="paper-shadow gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader className="bg-muted/50">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="hover:bg-transparent">
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns.length} className="h-32 text-center">
                      <p className="text-sm text-muted-foreground">
                        No requests match the current filter.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          setTab("all");
                          setSearch("");
                        }}
                      >
                        Reset filters
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleRows.map((row) => {
                    const isSelected = activeRowId === row.original.id;
                    return (
                      <TableRow
                        key={row.id}
                        ref={(el) => {
                          rowRefs.current[row.original.id] = el;
                        }}
                        data-selected={isSelected ? "true" : undefined}
                        aria-selected={isSelected || undefined}
                        onClick={() => navigate(`/requests/${row.original.id}`)}
                        className={`cursor-pointer ${
                          isSelected ? "bg-muted/70 ring-1 ring-inset ring-primary/40" : ""
                        }`}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            onClick={
                              cell.column.id === "select" || cell.column.id === "actions"
                                ? (e) => e.stopPropagation()
                                : undefined
                            }
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
