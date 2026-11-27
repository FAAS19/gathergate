import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowSquareOut, ArrowsClockwise, EnvelopeSimple, SlidersHorizontal } from "@phosphor-icons/react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apiJson,
  formatRelativeTime,
  IS_DEMO,
  type OutboxEmailDto,
  type SessionResponse,
} from "@/lib/api";

function demoPortalPath(url: string): string {
  const hashIdx = url.indexOf("#/c/");
  if (hashIdx >= 0) return url.slice(hashIdx + 1);
  const pathIdx = url.indexOf("/c/");
  return pathIdx >= 0 ? url.slice(pathIdx) : "/";
}

function extractMagicUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+\/c\/[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function extractOtpCode(subject: string, text: string): string | null {
  const m = subject.match(/^(\d{6}) is your verification code/i) || text.match(/\n(\d{6})\n/);
  return m ? m[1] : null;
}

export function OutboxPage({
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
  const [emailBackend, setEmailBackend] = useState(session.readiness.emailBackend);
  const [outbox, setOutbox] = useState<OutboxEmailDto[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [emailView, setEmailView] = useState<"html" | "text">("html");
  const [loading, setLoading] = useState(true);

  const loadOutbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiJson<{ emailBackend: string; emails: OutboxEmailDto[] }>("/api/outbox");
      setEmailBackend(res.emailBackend);
      setOutbox(res.emails);
      if (res.emails.length > 0) {
        setSelectedEmailId((prev) =>
          prev && res.emails.some((m) => m.id === prev) ? prev : res.emails[0].id
        );
      }
      void onSessionRefresh();
    } catch {
      toast.error("Failed to load Local Email Outbox.");
    } finally {
      setLoading(false);
    }
  }, [onSessionRefresh]);

  useEffect(() => {
    loadOutbox();
  }, [loadOutbox]);

  const activeEmail = outbox.find((e) => e.id === selectedEmailId) ?? outbox[0] ?? null;
  const activeMagicUrl = activeEmail ? extractMagicUrl(activeEmail.text_body) : null;
  const activeOtp = activeEmail ? extractOtpCode(activeEmail.subject, activeEmail.text_body) : null;

  return (
    <AppShell
      session={session}
      breadcrumbs={[{ label: "Local Email Outbox" }]}
      onSessionRefresh={onSessionRefresh}
      onDemoChanged={loadOutbox}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">Local Email Outbox</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Preview client invites, 6-digit verification codes, revision notices and scheduled reminders captured locally.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {emailBackend === "console" && (
              <Button asChild variant="outline" size="sm">
                <Link to="/settings?section=email">
                  <SlidersHorizontal className="mr-1.5 size-3.5" />
                  Configure SMTP or Resend
                </Link>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={loadOutbox} disabled={loading}>
              <ArrowsClockwise className="mr-1.5 size-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        {outbox.length === 0 ? (
          <Card className="paper-shadow p-10 text-center text-sm text-muted-foreground">
            <EnvelopeSimple className="mx-auto mb-2.5 size-7 text-muted-foreground/70" />
            <p>
              No outbound emails recorded yet. Create a checklist request, trigger an OTP, or send a test email to inspect messages here.
            </p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-12">
            <Card className="paper-shadow gap-0 overflow-hidden py-0 lg:col-span-5 lg:self-start">
              <div className="max-h-[560px] divide-y divide-border overflow-y-auto">
                {outbox.map((msg) => {
                  const active = activeEmail?.id === msg.id;
                  return (
                    <button
                      key={msg.id}
                      type="button"
                      onClick={() => setSelectedEmailId(msg.id)}
                      className={`w-full cursor-pointer px-4 py-3 text-left transition-colors ${
                        active ? "bg-accent" : "hover:bg-muted/60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {msg.kind === "otp" ? "Code" : msg.kind}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {formatRelativeTime(msg.created_at)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-foreground">
                        {msg.subject}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">To: {msg.recipient}</p>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card className="paper-shadow lg:col-span-7">
              {activeEmail && (
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">
                        {activeEmail.subject}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        To: <span className="font-mono text-foreground">{activeEmail.recipient}</span>
                        {" · "}
                        {new Date(activeEmail.created_at).toLocaleString("en-AU")}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {activeOtp && (
                        <Badge className="font-mono text-xs">OTP: {activeOtp}</Badge>
                      )}
                      {activeMagicUrl && (
                        <Button asChild size="sm">
                          {IS_DEMO ? (
                            <Link to={demoPortalPath(activeMagicUrl)}>
                              Open magic link
                              <ArrowSquareOut className="ml-1.5 size-3.5" />
                            </Link>
                          ) : (
                            <a href={activeMagicUrl} target="_blank" rel="noopener noreferrer">
                              Open magic link
                              <ArrowSquareOut className="ml-1.5 size-3.5" />
                            </a>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>

                  {activeEmail.html_body ? (
                    <Tabs value={emailView} onValueChange={(v) => setEmailView(v as "html" | "text")} className="space-y-3">
                      <TabsList className="h-8">
                        <TabsTrigger value="html" className="text-xs">Email</TabsTrigger>
                        <TabsTrigger value="text" className="text-xs">Plain text</TabsTrigger>
                      </TabsList>
                      <TabsContent value="html">
                        {/* Empty sandbox: no scripts, no same-origin access, no forms. */}
                        <iframe
                          title={`Preview of ${activeEmail.subject}`}
                          sandbox=""
                          srcDoc={activeEmail.html_body}
                          className="h-[560px] w-full rounded-lg border border-border bg-white"
                        />
                      </TabsContent>
                      <TabsContent value="text">
                        <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                          {activeEmail.text_body}
                        </pre>
                      </TabsContent>
                    </Tabs>
                  ) : (
                    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                      {activeEmail.text_body}
                    </pre>
                  )}
                </CardContent>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
