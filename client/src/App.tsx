import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/use-theme";
import { apiJson, IS_DEMO, type SessionResponse } from "@/lib/api";
import { ClientPortalPage } from "@/pages/client-portal-page";
import { ClientsPage } from "@/pages/clients-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { LoginPage } from "@/pages/login-page";
import { NewRequestPage } from "@/pages/new-request-page";
import { OutboxPage } from "@/pages/outbox-page";
import { RequestDetailPage } from "@/pages/request-detail-page";
import { SettingsPage } from "@/pages/settings-page";
import { SetupPage } from "@/pages/setup-page";
import { TemplatesPage } from "@/pages/templates-page";

const DEMO_STATIC_PATHS = new Set([
  "/requests/req_demo_tax",
  "/requests/req_demo_bas",
  "/requests/req_demo_health",
  "/requests/new",
]);
const DEMO_STATIC_PORTALS = new Set(["/c/demo-tax", "/c/demo-bas", "/c/demo-health"]);

function DemoBar({ onReset }: { onReset: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [resetting, setResetting] = useState(false);

  async function handleReset() {
    if (import.meta.env.VITE_DEMO !== "1") return;
    setResetting(true);
    try {
      const { resetDemoState } = await import("@/lib/demo-api");
      resetDemoState();
      if (
        (location.pathname.startsWith("/requests/") && !DEMO_STATIC_PATHS.has(location.pathname)) ||
        (location.pathname.startsWith("/c/") && !DEMO_STATIC_PORTALS.has(location.pathname))
      ) {
        navigate("/", { replace: true });
      }
      onReset();
    } finally {
      setResetting(false);
    }
  }

  const isOutbox = location.pathname === "/outbox";
  const isOperator = !location.pathname.startsWith("/c/") && !isOutbox;
  const isClientBas = location.pathname === "/c/demo-bas";
  const isClientTax = location.pathname === "/c/demo-tax";

  const linkClass = (active: boolean) =>
    `whitespace-nowrap rounded px-1.5 py-0.5 transition-colors hover:bg-primary-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/80 ${
      active ? "bg-primary-foreground/15 font-medium underline underline-offset-4" : ""
    }`;

  return (
    <nav
      aria-label="Demo navigation"
      className="relative z-40 border-b border-primary-foreground/15 bg-primary text-primary-foreground md:sticky md:top-0"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2 text-xs md:h-10 md:flex-nowrap md:py-0">
        <span className="font-medium tracking-tight">
          Interactive browser demo (no server)
          <span className="hidden font-normal lg:inline"> · Local browser only, no emails sent</span>
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
          <Link to="/" className={linkClass(isOperator)}>
            Operator console
          </Link>
          <Link to="/c/demo-bas" className={linkClass(isClientBas)}>
            Client portal
          </Link>
          <Link to="/c/demo-tax" className={linkClass(isClientTax)}>
            OTP portal
          </Link>
          <Link to="/outbox" className={linkClass(isOutbox)}>
            Local outbox
          </Link>
          <button
            type="button"
            disabled={resetting}
            onClick={() => void handleReset()}
            className="cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 transition-colors hover:bg-primary-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/80 disabled:opacity-60"
          >
            Reset demo
          </button>
          <a
            href="../"
            className="whitespace-nowrap rounded px-1.5 py-0.5 transition-colors hover:bg-primary-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/80"
          >
            Overview
          </a>
        </div>
      </div>
    </nav>
  );
}

function AppRoutes({ onReset }: { onReset: () => void }) {
  const location = useLocation();
  const isClientPortal = location.pathname.startsWith("/c/");
  const { theme, toggleTheme } = useTheme(!isClientPortal);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isClientPortal);

  const refreshSession = useCallback(async () => {
    setSessionError(null);
    try {
      const res = await apiJson<SessionResponse>("/api/session");
      setSession(res);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Could not reach GatherGate.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isClientPortal) {
      refreshSession();
    }
  }, [isClientPortal, refreshSession]);

  let content: ReactNode;

  if (isClientPortal) {
    content = (
      <Routes>
        <Route path="/c/:token" element={<ClientPortalPage />} />
        <Route path="*" element={<ClientPortalPage />} />
      </Routes>
    );
  } else if (loading) {
    content = (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading GatherGate...
      </div>
    );
  } else if (sessionError || !session) {
    content = (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-base font-semibold text-foreground">Unable to connect to GatherGate</h1>
          <p className="text-sm text-muted-foreground">
            {sessionError || "The server did not respond. Check that GatherGate is running and try again."}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refreshSession();
            }}
            className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  } else if (session.needsSetup) {
    content = (
      <Routes>
        <Route path="/setup" element={<SetupPage onComplete={refreshSession} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  } else if (!session.user) {
    content = (
      <Routes>
        <Route
          path="/login"
          element={<LoginPage multiTenant={session.multiTenant} onComplete={refreshSession} />}
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  } else {
    content = (
      <Routes>
        <Route
          path="/"
          element={
            <DashboardPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/clients"
          element={
            <ClientsPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/requests/new"
          element={
            <NewRequestPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/requests/:id"
          element={
            <RequestDetailPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/templates"
          element={
            <TemplatesPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/settings"
          element={
            <SettingsPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route
          path="/outbox"
          element={
            <OutboxPage
              session={session}
              onSessionRefresh={refreshSession}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (!IS_DEMO) return <>{content}</>;

  return (
    <div className="flex min-h-screen flex-col">
      <DemoBar onReset={onReset} />
      <div className="min-h-0 flex-1 md:[&_[data-slot=sidebar-wrapper]]:min-h-[calc(100svh-2.5rem)] md:[&_[data-slot=sidebar-container]]:top-10 md:[&_[data-slot=sidebar-container]]:h-[calc(100svh-2.5rem)] md:[&_.sticky.top-0]:top-10">
        {content}
      </div>
    </div>
  );
}

export function App() {
  const [demoEpoch, setDemoEpoch] = useState(0);
  const Router = IS_DEMO ? HashRouter : BrowserRouter;

  return (
    <TooltipProvider>
      <Router>
        <AppRoutes key={demoEpoch} onReset={() => setDemoEpoch((e) => e + 1)} />
        <Toaster position="bottom-right" />
      </Router>
    </TooltipProvider>
  );
}
