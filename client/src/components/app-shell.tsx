import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ChevronUp,
  ExternalLink,
  FolderCheck,
  Inbox,
  LayoutList,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Info,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { apiJson, formatBytes, type SessionResponse } from "@/lib/api";

function SidebarLogo() {
  const { state } = useSidebar();
  return <BrandMark collapsed={state === "collapsed"} />;
}

export function AppShell({
  session,
  breadcrumbs,
  storageBytes,
  demoPortalUrl,
  onSessionRefresh,
  onDemoChanged,
  theme,
  onToggleTheme,
  children,
}: {
  session: SessionResponse;
  breadcrumbs: Array<{ label: string; to?: string }>;
  storageBytes?: number;
  demoPortalUrl?: string | null;
  onSessionRefresh: () => Promise<void>;
  onDemoChanged?: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [clearingDemo, setClearingDemo] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }

      if (
        !isEditable &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "c" &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault();
        navigate("/requests/new");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  async function handleLogout() {
    await apiJson("/api/logout", { method: "POST" });
    await onSessionRefresh();
    navigate("/login");
  }

  async function handleClearDemo() {
    setClearingDemo(true);
    try {
      await apiJson("/api/demo/clear", { method: "POST" });
      toast.success("Sample packs removed and encrypted demo files shredded.");
      await onSessionRefresh();
      if (onDemoChanged) await onDemoChanged();
    } catch {
      toast.error("Could not clear sample workspace.");
    } finally {
      setClearingDemo(false);
    }
  }

  const navItems = [
    {
      label: "Requests",
      to: "/",
      icon: FolderCheck,
      active: location.pathname === "/" || location.pathname.startsWith("/requests"),
    },
    {
      label: "Templates",
      to: "/templates",
      icon: LayoutList,
      active: location.pathname.startsWith("/templates"),
    },
    {
      label: "Local Outbox",
      to: "/outbox",
      icon: Inbox,
      active: location.pathname === "/outbox",
      badge: session.readiness.outboxCount > 0 ? String(session.readiness.outboxCount) : undefined,
    },
    {
      label: "Settings",
      to: "/settings",
      icon: Settings,
      active: location.pathname === "/settings",
    },
  ];

  const workspace = session.workspace;
  const user = session.user;
  const isLocalOutbox = session.readiness.emailBackend === "console";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
          <Link to="/" className="flex items-center focus:outline-none">
            <SidebarLogo />
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge && <SidebarMenuBadge className="tabular-nums">{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="mt-auto group-data-[collapsible=icon]:hidden">
            <div className="mx-2 rounded-lg border border-sidebar-border bg-card/70 p-3 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                <span>Self-hosted · Vault active</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {storageBytes !== undefined ? `Encrypted store: ${formatBytes(storageBytes)}` : `AES-256-GCM (${session.readiness.storageBackend})`}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Email: {isLocalOutbox ? "Local preview outbox" : session.readiness.emailBackend.toUpperCase()}
              </p>
            </div>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg" className="justify-between">
                    <div className="flex min-w-0 flex-col text-left leading-tight">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {workspace?.name || "Workspace"}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {user?.email}
                      </span>
                    </div>
                    <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  {onToggleTheme && (
                    <DropdownMenuItem onClick={onToggleTheme}>
                      {theme === "dark" ? <Sun className="mr-2 size-4" /> : <Moon className="mr-2 size-4" />}
                      {theme === "dark" ? "Switch to daylight mode" : "Switch to dark mode"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => navigate("/settings")}>
                    <Settings className="mr-2 size-4" />
                    Instance & webhook settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                    <LogOut className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        {session.readiness.hasDemoData && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/90 px-4 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6">
            <div className="flex items-center gap-2">
              <Info className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
              <span>
                <strong>Demo workspace active.</strong> Sample client packs loaded; outbound emails route to the{" "}
                <Link to="/outbox" className="font-medium underline underline-offset-2">
                  Local Outbox
                </Link>
                .
              </span>
            </div>
            <div className="flex items-center gap-2">
              {demoPortalUrl && (
                <Button asChild size="xs" variant="outline" className="h-7 bg-card text-foreground hover:bg-muted dark:bg-card dark:hover:bg-muted">
                  <a href={demoPortalUrl} target="_blank" rel="noopener noreferrer">
                    Open client portal
                    <ExternalLink className="ml-1 size-3" />
                  </a>
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={handleClearDemo}
                disabled={clearingDemo}
                className="h-7 text-amber-900 hover:bg-amber-200/60 dark:text-amber-200 dark:hover:bg-amber-900/50"
              >
                <Trash2 className="mr-1 size-3" />
                {clearingDemo ? "Clearing..." : "Clear demo data"}
              </Button>
            </div>
          </div>
        )}

        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/90 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarTrigger className="-ml-1" />
            <div className="h-4 w-px bg-border" />
            <Breadcrumb>
              <BreadcrumbList>
                {breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <Fragment key={crumb.label}>
                      <BreadcrumbItem>
                        {crumb.to && !isLast ? (
                          <BreadcrumbLink asChild>
                            <Link to={crumb.to}>{crumb.label}</Link>
                          </BreadcrumbLink>
                        ) : (
                          <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                        )}
                      </BreadcrumbItem>
                      {!isLast && <BreadcrumbSeparator />}
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCmdOpen(true)}
              className="hidden h-8 gap-2 text-xs text-muted-foreground sm:inline-flex"
            >
              <Search className="size-3.5" />
              <span>Quick jump</span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                Ctrl K
              </kbd>
            </Button>
            <Button asChild size="sm" className="h-8 gap-1.5 text-xs font-medium">
              <Link to="/requests/new">
                <Plus className="size-3.5" />
                <span>New request</span>
                <kbd className="hidden rounded bg-primary-foreground/20 px-1 py-0.5 font-mono text-[10px] sm:inline">
                  C
                </kbd>
              </Link>
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </SidebarInset>

      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen}>
        <Command>
          <CommandInput placeholder="Jump to page or action..." />
          <CommandList>
            <CommandEmpty>No matching command.</CommandEmpty>
            <CommandGroup heading="Navigation">
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/");
                }}
              >
                <FolderCheck className="mr-2 size-4" />
                Intake Requests
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/requests/new");
                }}
              >
                <Plus className="mr-2 size-4" />
                Create New Checklist Request
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/templates");
                }}
              >
                <LayoutList className="mr-2 size-4" />
                Checklist Templates & Visual Builder
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/outbox");
                }}
              >
                <Inbox className="mr-2 size-4" />
                Local Email Outbox
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/settings");
                }}
              >
                <Settings className="mr-2 size-4" />
                Settings & Webhooks
              </CommandItem>
            </CommandGroup>
            {onToggleTheme && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Appearance">
                  <CommandItem
                    onSelect={() => {
                      setCmdOpen(false);
                      onToggleTheme();
                    }}
                  >
                    {theme === "dark" ? <Sun className="mr-2 size-4" /> : <Moon className="mr-2 size-4" />}
                    Toggle daylight / dark theme
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </SidebarProvider>
  );
}
