import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/use-theme";
import { apiJson, type SessionResponse } from "@/lib/api";
import { ClientPortalPage } from "@/pages/client-portal-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { LoginPage } from "@/pages/login-page";
import { NewRequestPage } from "@/pages/new-request-page";
import { OutboxPage } from "@/pages/outbox-page";
import { RequestDetailPage } from "@/pages/request-detail-page";
import { SettingsPage } from "@/pages/settings-page";
import { SetupPage } from "@/pages/setup-page";
import { TemplatesPage } from "@/pages/templates-page";

function AppRoutes() {
  const location = useLocation();
  const isClientPortal = location.pathname.startsWith("/c/");
  const { theme, toggleTheme } = useTheme(!isClientPortal);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(!isClientPortal);

  const refreshSession = useCallback(async () => {
    try {
      const res = await apiJson<SessionResponse>("/api/session");
      setSession(res);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isClientPortal) {
      refreshSession();
    }
  }, [isClientPortal, refreshSession]);

  if (isClientPortal) {
    return (
      <Routes>
        <Route path="/c/:token" element={<ClientPortalPage />} />
      </Routes>
    );
  }

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading GatherGate...
      </div>
    );
  }

  if (session.needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage onComplete={refreshSession} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!session.user) {
    return (
      <Routes>
        <Route
          path="/login"
          element={<LoginPage multiTenant={session.multiTenant} onComplete={refreshSession} />}
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
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

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <AppRoutes />
        <Toaster position="bottom-right" />
      </BrowserRouter>
    </TooltipProvider>
  );
}
