import { useCallback, useEffect, useMemo, useState } from "react";
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
  CheckCircle as CheckCircle2,
  Clock,
  Copy,
  DotsThree as MoreHorizontal,
  DownloadSimple as Download,
  Eye,
  FolderOpen,
  MagnifyingGlass as Search,
  Pause,
  Play,
  Plus,
  Warning as AlertTriangle,
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

type FilterTab = "all" | "awaiting_review" | "needs_revision" | "open" | "completed" | "purged";

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
      toast.success("Loaded 3 sample Australian client packs.");
      await onSessionRefresh();
      await loadRequests({ silent: true });
    } catch {
      toast.error("Could not load sample workspace.");
    } finally {
      setSeeding(false);
    }
  }

  async function handleCopyLink(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Magic link copied to clipboard.");
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
      if (tab === "awaiting_review" && !(r.submitted_items > 0 && r.status !== "purged")) return false;
      if (tab === "needs_revision" && !(r.rejected_items > 0 && r.status !== "purged")) return false;
      if (tab === "open" && r.status !== "open") return false;
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
          <div className="pr-2">
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
          </div>
        ),
        cell: ({ row }) => {
          const r = row.original;
          const active = isActiveRequest(r);
          return (
            <div className="pr-2">
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
            </div>
          );
        },
      },
      {
        accessorKey: "title",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs font-medium"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Checklist
            <ArrowUpDown className="ml-1.5 size-3.5" />
          </Button>
        ),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  to={`/requests/${r.id}`}
                  className="truncate font-medium text-foreground hover:text-primary hover:underline"
                >
                  {r.title}
                </Link>
                {r.is_demo && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                    Demo
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {r.due_at && (
                  <span className="tabular-nums">
                    Due {new Date(r.due_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </span>
                )}
                {r.last_opened_at && (
                  <span>· Opened {formatRelativeTime(r.last_opened_at)}</span>
                )}
              </div>
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
            <div>
              <div className="font-medium text-foreground">{r.client_name}</div>
              <div className="text-xs text-muted-foreground">{r.client_email}</div>
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
            <div className="w-36 space-y-1">
              <div className="flex items-center justify-between text-xs tabular-nums">
                <span className="font-medium text-foreground">
                  {r.approved_items}/{r.total_items} verified
                </span>
                <span className="text-muted-foreground">{pct}%</span>
              </div>
              <Progress aria-label={`${r.title} completion`} value={pct} className="h-1.5" />
              {(r.submitted_items > 0 || r.rejected_items > 0) && (
                <div className="flex gap-2 text-[11px]">
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
            <div className="flex items-center justify-end gap-1.5">
              <Button
                size="sm"
                variant={r.submitted_items > 0 ? "default" : "outline"}
                className="h-7 px-2.5 text-xs"
                onClick={() => navigate(`/requests/${r.id}`)}
              >
                {actionLabel}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Copy magic link"
                aria-label="Copy magic link"
                onClick={() => void handleCopyLink(r.portal_url)}
              >
                <Copy className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="More actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <a href={r.portal_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-2 size-3.5" />
                      Open client portal
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleCopyLink(r.portal_url)}>
                    <Copy className="mr-2 size-3.5" />
                    Copy magic link
                  </DropdownMenuItem>
                  {active && (
                    <DropdownMenuItem
                      onClick={() => void handleBulkReminders([r.id], !r.reminders_paused)}
                    >
                      {r.reminders_paused ? (
                        <>
                          <Play className="mr-2 size-3.5" />
                          Resume reminders
                        </>
                      ) : (
                        <>
                          <Pause className="mr-2 size-3.5" />
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
                          <Download className="mr-2 size-3.5" />
                          Download pack (.zip)
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem asChild>
                          <a href={`/api/requests/${r.id}/export.zip`}>
                            <Download className="mr-2 size-3.5" />
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

  const kpis = data?.kpis ?? { active: 0, awaitingReview: 0, needsRevision: 0, completed: 0 };

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
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Intake Requests
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Track passwordless client submissions, verify statutory details, and dispatch automated follow-ups.
            </p>
          </div>
          {data && (
            <div className="text-xs text-muted-foreground tabular-nums">
              Vault storage: <strong className="text-foreground">{formatBytes(data.storageBytes)}</strong>
              {data.workspace.max_storage_bytes > 0
                ? ` / ${formatBytes(data.workspace.max_storage_bytes)}`
                : " · Self-hosted unlimited"}
            </div>
          )}
        </div>

        {/* 4 Clickable KPI Summary Cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "Active Requests",
              value: kpis.active,
              sub: "Open or in review",
              icon: Clock,
              targetTab: "open" as FilterTab,
              accent: "text-foreground",
            },
            {
              label: "Awaiting Review",
              value: kpis.awaitingReview,
              sub: "Packs with new items",
              icon: Eye,
              targetTab: "awaiting_review" as FilterTab,
              accent: "text-blue-700 dark:text-blue-300",
            },
            {
              label: "Needs Revision",
              value: kpis.needsRevision,
              sub: "Returned to client",
              icon: AlertTriangle,
              targetTab: "needs_revision" as FilterTab,
              accent: "text-amber-700 dark:text-amber-300",
            },
            {
              label: "Completed",
              value: kpis.completed,
              sub: "Approved & exportable",
              icon: CheckCircle2,
              targetTab: "completed" as FilterTab,
              accent: "text-primary",
            },
          ].map((kpi) => {
            const Icon = kpi.icon;
            const isActive = tab === kpi.targetTab;
            return (
              <button
                key={kpi.label}
                type="button"
                aria-pressed={isActive}
                onClick={() => setTab(isActive ? "all" : kpi.targetTab)}
                className={`paper-shadow flex w-full cursor-pointer flex-col rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive ? "border-primary ring-1 ring-primary/30" : ""
                }`}
              >
                <div className="flex w-full items-center justify-between pb-2">
                  <span className="text-xs font-medium text-muted-foreground">{kpi.label}</span>
                  <Icon className={`size-4 ${kpi.accent}`} weight="duotone" />
                </div>
                <div className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
                  {loading ? <Skeleton className="h-8 w-12" /> : kpi.value}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{kpi.sub}</p>
              </button>
            );
          })}
        </div>

        {/* Filter Tabs + Search */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Filter requests by status"
            className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 text-xs"
          >
            {(
              [
                ["all", "All"],
                ["awaiting_review", "Awaiting review"],
                ["needs_revision", "Needs revision"],
                ["open", "Open"],
                ["completed", "Completed"],
                ["purged", "Purged"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  tab === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

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
          <Card className="paper-shadow overflow-hidden">
            <div className="border-b border-border bg-muted/60 px-4 py-3">
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
              <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
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
          <Card className="paper-shadow overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/60">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} className="text-xs font-medium text-muted-foreground">
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
                  <TableRow>
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
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} className="hover:bg-muted/40">
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
