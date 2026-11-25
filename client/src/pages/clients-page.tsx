import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, MagnifyingGlass, Plus, Users } from "@phosphor-icons/react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  formatRelativeTime,
  type ClientSummaryDto,
  type SessionResponse,
} from "@/lib/api";
import { getInitials } from "@/lib/identity";

function newRequestHref(client: Pick<ClientSummaryDto, "name" | "email">) {
  const qs = new URLSearchParams({
    clientName: client.name,
    clientEmail: client.email,
  });
  return `/requests/new?${qs.toString()}`;
}

export function ClientsPage({
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
  const [clients, setClients] = useState<ClientSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  const loadClients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiJson<{ clients: ClientSummaryDto[] }>("/api/clients");
      setClients(res.clients);
    } catch {
      toast.error("Failed to load clients.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
    );
  }, [clients, search]);

  const selectedClient = useMemo(
    () => clients.find((c) => c.email === selectedEmail) ?? null,
    [clients, selectedEmail]
  );

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Clients" }]}
      onSessionRefresh={onSessionRefresh}
      onDemoChanged={loadClients}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">Clients</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every client from your intake packs. Open a client to inspect past requests or launch a repeat checklist.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Filter clients"
              placeholder="Search by client name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        {loading ? (
          <Card className="paper-shadow gap-0 overflow-hidden py-0">
            <div className="divide-y divide-border">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-9 rounded-full" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-52" />
                    </div>
                  </div>
                  <Skeleton className="h-8 w-28" />
                </div>
              ))}
            </div>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="paper-shadow flex flex-col items-center justify-center p-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="size-5" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-foreground">
              {clients.length === 0 ? "No clients yet" : "No matching clients"}
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {clients.length === 0
                ? "Clients appear here automatically as soon as you send your first checklist request."
                : "Try another name or email address."}
            </p>
            {clients.length === 0 && (
              <Button asChild className="mt-5" size="sm">
                <Link to="/requests/new">
                  <Plus className="mr-1.5 size-4" />
                  New request
                </Link>
              </Button>
            )}
          </Card>
        ) : (
          <Card className="paper-shadow gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Active packs</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((client) => (
                  <TableRow
                    key={client.email}
                    className="cursor-pointer"
                    onClick={() => setSelectedEmail(client.email)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary">
                          {getInitials(client.name, "C")}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{client.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{client.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{client.activeRequests}</span>
                        {client.awaitingReviewRequests > 0 && (
                          <Badge variant="outline" className="border-blue-200 bg-blue-50 text-[11px] text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/60 dark:text-blue-300">
                            {client.awaitingReviewRequests} to review
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums text-muted-foreground">
                      {client.completedRequests} of {client.totalRequests}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums text-muted-foreground">
                      {formatRelativeTime(client.lastActivityAt)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button asChild variant="outline" size="xs">
                        <Link to={newRequestHref(client)}>
                          <Plus className="mr-1 size-3" />
                          New request
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      <Sheet open={Boolean(selectedClient)} onOpenChange={(open) => !open && setSelectedEmail(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
          {selectedClient && (
            <>
              <SheetHeader className="space-y-3 border-b border-border pb-4 pr-10 text-left">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {getInitials(selectedClient.name, "C")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate">{selectedClient.name}</SheetTitle>
                    <SheetDescription className="truncate">{selectedClient.email}</SheetDescription>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {selectedClient.totalRequests} total pack{selectedClient.totalRequests === 1 ? "" : "s"}
                  </span>
                  <Button asChild size="sm">
                    <Link to={newRequestHref(selectedClient)}>
                      <Plus className="mr-1.5 size-3.5" />
                      New request
                    </Link>
                  </Button>
                </div>
              </SheetHeader>

              <div className="space-y-2.5 px-4 pb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Checklist history
                </h3>
                {selectedClient.requests.map((req) => (
                  <Link
                    key={req.id}
                    to={`/requests/${req.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/50"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{req.title}</p>
                        <StatusBadge status={req.status} />
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {req.approved_items}/{req.total_items} verified · Created {formatRelativeTime(req.created_at)}
                      </p>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
