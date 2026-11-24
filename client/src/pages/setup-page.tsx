import { useState, type FormEvent } from "react";
import { ArrowRight, Check, CircleNotch } from "@phosphor-icons/react";
import { BrandMark } from "@/components/brand-mark";
import { PasswordInput } from "@/components/password-input";
import { PortalPreview } from "@/components/portal-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiJson, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const MIN_PASSWORD = 10;

export function SetupPage({ onComplete }: { onComplete: () => Promise<void> }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loadDemo, setLoadDemo] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordOk = password.length >= MIN_PASSWORD;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiJson("/api/setup", {
        method: "POST",
        body: JSON.stringify({ workspaceName, email, password, loadDemo }),
      });
      await onComplete();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your workspace. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <main className="flex flex-col px-6 py-8 sm:px-10">
        <BrandMark />

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12">
          <div className="animate-in fade-in slide-in-from-bottom-1 duration-500 motion-reduce:animate-none">
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.025em]">Set up your workspace</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">
              Takes about a minute. Everything stays on your server.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-9 space-y-5">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="workspaceName">Practice name</Label>
              <Input
                id="workspaceName"
                required
                autoFocus
                autoComplete="organization"
                placeholder="Harbour Advisory"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Your email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@practice.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                id="password"
                required
                minLength={MIN_PASSWORD}
                autoComplete="new-password"
                aria-describedby="password-hint"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10"
              />
              <p
                id="password-hint"
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-colors duration-200",
                  passwordOk ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Check className={cn("size-3.5 transition-opacity duration-200", passwordOk ? "opacity-100" : "opacity-30")} />
                At least {MIN_PASSWORD} characters
              </p>
            </div>

            <label htmlFor="loadDemo" className="flex cursor-pointer items-center gap-2.5 pt-1 text-sm text-muted-foreground">
              <Checkbox id="loadDemo" checked={loadDemo} onCheckedChange={(v) => setLoadDemo(v === true)} />
              Add 3 sample requests to explore
            </label>

            <Button type="submit" className="group h-10 w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <CircleNotch className="size-4 animate-spin" /> Creating workspace
                </>
              ) : (
                <>
                  Create workspace
                  <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </>
              )}
            </Button>
          </form>
        </div>
      </main>

      <aside className="relative hidden items-center justify-center overflow-hidden border-l border-border bg-secondary lg:flex">
        <div className="flex w-full max-w-[420px] flex-col items-center px-10">
          <PortalPreview
            name={workspaceName}
            className="animate-in fade-in slide-in-from-bottom-3 duration-700 motion-reduce:animate-none"
          />
          <p className="mt-8 max-w-[320px] text-center text-sm leading-relaxed text-muted-foreground">
            This is what your clients see. No passwords, no app to install, and every file is encrypted on arrival.
          </p>
        </div>
      </aside>
    </div>
  );
}
