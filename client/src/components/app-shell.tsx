import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ArrowSquareOut,
  CaretUp,
  EnvelopeSimple,
  Folders,
  Gear,
  Info,
  ListChecks,
  MagnifyingGlass,
  Moon,
  Palette,
  Plus,
  SidebarSimple,
  SignOut,
  Sun,
  Trash,
  Tray,
  UserCircle,
  Users,
} from "@phosphor-icons/react";
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
  DropdownMenuLabel,
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
import { apiJson, type SessionResponse } from "@/lib/api";
import { getInitials, operatorDisplayName } from "@/lib/identity";

function SidebarBrandHeader({ workspaceName }: { workspaceName?: string }) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 py-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Expand sidebar"
          title="Expand sidebar ([)"
          className="size-8 text-muted-foreground hover:text-foreground"
        >
          <SidebarSimple className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <Link to="/" className="min-w-0 flex-1 focus:outline-none">
        <BrandMark subtitle={workspaceName} />
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        aria-label="Collapse sidebar"
        title="Collapse sidebar ([)"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <SidebarSimple className="size-4" />
      </Button>
    </div>
  );
}

function AppShellInner({
  session,
  breadcrumbs,
  demoPortalUrl,
  onSessionRefresh,
  onDemoChanged,
  theme,
  onToggleTheme,
  children,
}: {
  session: SessionResponse;
  breadcrumbs: Array<{ label: string; to?: string }>;
  demoPortalUrl?: string | null;
  onSessionRefresh: () => Promise<void>;
  onDemoChanged?: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
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

      if (isEditable || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) {
        return;
      }

      if (e.key === "[") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        navigate("/requests/new");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, toggleSidebar]);

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

  const awaitingReview = session.readiness.awaitingReviewCount ?? 0;
  const showOutbox =
    session.readiness.emailBackend === "console" || session.readiness.outboxCount > 0;

  const primaryNav = [
    {
      label: "Requests",
      to: "/",
      icon: Folders,
      active: location.pathname === "/" || location.pathname.startsWith("/requests"),
      badge: awaitingReview > 0 ? String(awaitingReview) : undefined,
    },
    {
      label: "Clients",
      to: "/clients",
      icon: Users,
      active: location.pathname.startsWith("/clients"),
    },
    {
      label: "Templates",
      to: "/templates",
      icon: ListChecks,
      active: location.pathname.startsWith("/templates"),
    },
  ];

  const secondaryNav = [
    ...(showOutbox
      ? [
          {
            label: "Local Outbox",
            to: "/outbox",
            icon: Tray,
            active: location.pathname === "/outbox",
            badge:
              session.readiness.outboxCount > 0
                ? String(session.readiness.outboxCount)
                : undefined,
          },
        ]
      : []),
    {
      label: "Settings",
      to: "/settings",
      icon: Gear,
      active: location.pathname === "/settings",
    },
  ];

  const workspace = session.workspace;
  const user = session.user;
  const opName = operatorDisplayName(user?.displayName, user?.email);
  const initials = getInitials(opName);

  return (
    <>
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
          <SidebarBrandHeader workspaceName={workspace?.name} />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {primaryNav.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon className="size-4" weight={item.active ? "duotone" : "regular"} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge && <SidebarMenuBadge className="tabular-nums">{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="mt-auto border-t border-sidebar-border/70 pt-2">
            <SidebarGroupContent>
              <SidebarMenu>
                {secondaryNav.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon className="size-4" weight={item.active ? "duotone" : "regular"} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge && <SidebarMenuBadge className="tabular-nums">{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg" className="justify-between gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                      {initials}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {opName}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {user?.email}
                      </span>
                    </div>
                    <CaretUp className="size-3.5 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-60">
                  <DropdownMenuLabel className="font-normal">
                    <p className="truncate text-xs font-semibold text-foreground">{opName}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {workspace?.name || user?.email}
                    </p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/settings?section=account")}>
                    <UserCircle className="mr-2 size-4" />
                    Account & password
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/settings?section=email")}>
                    <EnvelopeSimple className="mr-2 size-4" />
                    Email delivery
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/settings?section=branding")}>
                    <Palette className="mr-2 size-4" />
                    Portal branding
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                    <SignOut className="mr-2 size-4" />
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
                    <ArrowSquareOut className="ml-1 size-3" />
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
                <Trash className="mr-1 size-3" />
                {clearingDemo ? "Clearing..." : "Clear demo data"}
              </Button>
            </div>
          </div>
        )}

        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/90 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarTrigger className="-ml-1 md:hidden" />
            <div className="h-4 w-px bg-border md:hidden" />
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
            {onToggleTheme && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleTheme}
                aria-label={theme === "dark" ? "Switch to daylight mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Switch to daylight mode" : "Switch to dark mode"}
                className="size-8 text-muted-foreground hover:text-foreground"
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCmdOpen(true)}
              className="hidden h-8 gap-2 text-xs text-muted-foreground sm:inline-flex"
            >
              <MagnifyingGlass className="size-3.5" />
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
                <Folders className="mr-2 size-4" />
                Intake Requests
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/clients");
                }}
              >
                <Users className="mr-2 size-4" />
                Clients Directory
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
                <ListChecks className="mr-2 size-4" />
                Checklist Templates & Visual Builder
              </CommandItem>
              {showOutbox && (
                <CommandItem
                  onSelect={() => {
                    setCmdOpen(false);
                    navigate("/outbox");
                  }}
                >
                  <Tray className="mr-2 size-4" />
                  Local Email Outbox
                </CommandItem>
              )}
              <CommandItem
                onSelect={() => {
                  setCmdOpen(false);
                  navigate("/settings");
                }}
              >
                <Gear className="mr-2 size-4" />
                Settings & Email Delivery
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
    </>
  );
}

export function AppShell({
  session,
  breadcrumbs,
  storageBytes: _storageBytes,
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
  return (
    <SidebarProvider>
      <AppShellInner
        session={session}
        breadcrumbs={breadcrumbs}
        demoPortalUrl={demoPortalUrl}
        onSessionRefresh={onSessionRefresh}
        onDemoChanged={onDemoChanged}
        theme={theme}
        onToggleTheme={onToggleTheme}
      >
        {children}
      </AppShellInner>
    </SidebarProvider>
  );
}
