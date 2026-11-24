import { useState, type FormEvent } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { BrandMark } from "@/components/brand-mark";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiJson, ApiError } from "@/lib/api";

type Mode = "signin" | "signup";

export function LoginPage({
  multiTenant,
  onComplete,
}: {
  multiTenant: boolean;
  onComplete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = mode === "signup";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiJson(signup ? "/api/signup" : "/api/login", {
        method: "POST",
        body: JSON.stringify(signup ? { workspaceName, email, password } : { email, password }),
      });
      await onComplete();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setSubmitting(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background px-6 py-8 sm:px-10">
      <BrandMark />
      <main className="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-12">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.025em]">
          {signup ? "Create a workspace" : "Welcome back"}
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          {signup ? "Start collecting documents in minutes." : "Sign in to your workspace."}
        </p>

        <form onSubmit={handleSubmit} className="mt-9 space-y-5">
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {signup && (
            <div className="space-y-2">
              <Label htmlFor="login-workspace">Practice name</Label>
              <Input
                id="login-workspace"
                required
                autoComplete="organization"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                className="h-10"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <PasswordInput
              id="login-password"
              required
              minLength={signup ? 10 : undefined}
              autoComplete={signup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
            />
          </div>

          <Button type="submit" className="h-10 w-full" disabled={submitting}>
            {submitting && <CircleNotch className="size-4 animate-spin" />}
            {signup ? "Create workspace" : "Sign in"}
          </Button>
        </form>

        {multiTenant && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {signup ? "Already have a workspace? " : "New here? "}
            <button
              type="button"
              onClick={() => switchMode(signup ? "signin" : "signup")}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {signup ? "Sign in" : "Create a workspace"}
            </button>
          </p>
        )}
      </main>
    </div>
  );
}
