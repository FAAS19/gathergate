import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, CircleNotch, Copy, Key, Plus, ShieldCheck, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  API_KEY_SCOPE_OPTIONS,
  apiJson,
  ApiError,
  formatRelativeTime,
  type ApiKeyDto,
  type ApiKeyScope,
} from "@/lib/api";
import { copyText } from "@/lib/utils";

function keyStatus(key: ApiKeyDto): { label: string; tone: "active" | "revoked" | "expired" } {
  if (key.revoked_at) return { label: "Revoked", tone: "revoked" };
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return { label: "Expired", tone: "expired" };
  }
  return { label: "Active", tone: "active" };
}

export function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["requests:read", "templates:read"]);
  const [expiryDays, setExpiryDays] = useState<string>("never");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<{ name: string; secret: string } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiJson<{ apiKeys: ApiKeyDto[] }>("/api/api-keys");
      setKeys(res.apiKeys);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  function toggleScope(scope: ApiKeyScope, checked: boolean) {
    setScopes((prev) =>
      checked ? (prev.includes(scope) ? prev : [...prev, scope]) : prev.filter((s) => s !== scope)
    );
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Enter a descriptive name for the API key.");
      return;
    }
    if (scopes.length === 0) {
      toast.error("Select at least one permission scope.");
      return;
    }
    setCreating(true);
    try {
      const res = await apiJson<{ apiKey: ApiKeyDto; secret: string }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          expiresInDays: expiryDays === "never" ? null : Number(expiryDays),
        }),
      });
      setCreatedSecret({ name: res.apiKey.name, secret: res.secret });
      setCopiedSecret(false);
      setName("");
      toast.success("API key created. Copy it now before leaving this page.");
      await loadKeys();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create API key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKeyDto) {
    setRevokingId(key.id);
    try {
      await apiJson(`/api/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast.success(`Revoked "${key.name}".`);
      await loadKeys();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not revoke API key.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="paper-shadow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Key className="size-4 text-primary" />
            Create Workspace API Key
          </CardTitle>
          <CardDescription className="text-xs">
            Issue scoped Bearer tokens (<code className="font-mono">gg_live_...</code>) for n8n, scripts, and AI agents. Keys are SHA-256 hashed at rest and cannot reveal unmasked national IDs or download raw files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {createdSecret && (
            <Alert className="border-primary/30 bg-accent/50">
              <ShieldCheck className="size-4 text-primary" />
              <AlertTitle className="text-sm font-medium">
                Copy secret for "{createdSecret.name}" now
              </AlertTitle>
              <AlertDescription className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  This token is shown once and cannot be retrieved again. Send it in the{" "}
                  <code className="font-mono">Authorization: Bearer</code> header.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    data-testid="new-api-key-secret"
                    className="flex-1 break-all rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground"
                  >
                    {createdSecret.secret}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const ok = await copyText(createdSecret.secret);
                      if (ok) {
                        setCopiedSecret(true);
                        toast.success("API key copied.");
                      } else {
                        toast.error("Could not copy API key.");
                      }
                    }}
                  >
                    {copiedSecret ? (
                      <>
                        <Check className="mr-1.5 size-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1.5 size-3.5" />
                        Copy key
                      </>
                    )}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name">Key label</Label>
                <Input
                  id="api-key-name"
                  placeholder="e.g. n8n Production Workflow"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="api-key-expiry">Expiration</Label>
                <Select value={expiryDays} onValueChange={setExpiryDays}>
                  <SelectTrigger id="api-key-expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">No expiry</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="365">1 year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Permission scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {API_KEY_SCOPE_OPTIONS.map((opt) => {
                  const id = `scope-${opt.value.replace(":", "-")}`;
                  const checked = scopes.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      htmlFor={id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted/40"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(v) => toggleScope(opt.value, v === true)}
                        className="mt-0.5"
                      />
                      <span className="space-y-0.5">
                        <span className="block font-mono text-xs font-medium text-foreground">
                          {opt.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {opt.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <Button type="submit" disabled={creating || !name.trim() || scopes.length === 0}>
              {creating ? (
                <CircleNotch className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Plus className="mr-1.5 size-4" />
              )}
              Create API key
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="paper-shadow">
        <CardHeader>
          <CardTitle className="text-base">Issued API Keys</CardTitle>
          <CardDescription className="text-xs">
            Revoking a key immediately invalidates future requests with HTTP 401.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading API keys...</p>
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API keys created yet. Create one above to authenticate n8n, scripts, or MCP clients.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {keys.map((key) => {
                const status = keyStatus(key);
                const isActive = status.tone === "active";
                return (
                  <div
                    key={key.id}
                    className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm text-foreground">{key.name}</span>
                        <Badge
                          variant={isActive ? "secondary" : "outline"}
                          className={
                            status.tone === "revoked"
                              ? "border-destructive/30 text-destructive"
                              : status.tone === "expired"
                                ? "text-muted-foreground"
                                : undefined
                          }
                        >
                          {status.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <code className="font-mono">{key.key_prefix}...</code>
                        <span>Last used: {formatRelativeTime(key.last_used_at)}</span>
                        {key.expires_at && (
                          <span>
                            Expires: {new Date(key.expires_at).toLocaleDateString("en-AU")}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} variant="outline" className="font-mono text-[11px]">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    {isActive && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={revokingId === key.id}
                        onClick={() => handleRevoke(key)}
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        {revokingId === key.id ? (
                          <CircleNotch className="mr-1.5 size-3.5 animate-spin" />
                        ) : (
                          <Trash className="mr-1.5 size-3.5" />
                        )}
                        Revoke
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
