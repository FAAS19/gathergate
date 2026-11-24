/** Server-registered validator key (see src/validators/packs). Unknown keys fail closed server-side. */
export type ValidatorKey = string;

export type ItemKind = "file" | "text" | "textarea" | "checkbox";

export interface TemplateItemSpec {
  section: string;
  label: string;
  helpText: string;
  kind: ItemKind;
  required: boolean;
  validator: ValidatorKey;
  allowedGroups?: string[];
  maxFileMb?: number;
  multiple?: boolean;
  slug?: string;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  plan: string;
  max_active_requests: number;
  max_storage_bytes: number;
  webhook_url: string | null;
  has_webhook_secret: boolean;
  brand_color: string | null;
  has_logo: boolean;
  support_email: string | null;
  support_phone: string | null;
  created_at: string;
}

export interface BrandingDto {
  name: string;
  brandColor: string | null;
  logoDataUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
}

export interface SessionResponse {
  needsSetup: boolean;
  multiTenant: boolean;
  user: { id: string; email: string } | null;
  workspace: WorkspaceDto | null;
  readiness: {
    storageBackend: string;
    emailBackend: string;
    cronIntervalMinutes: number;
    defaultPurgeDays: number;
    hasDemoData: boolean;
    outboxCount: number;
  };
}

export interface RequestSummaryDto {
  id: string;
  title: string;
  client_name: string;
  client_email: string;
  status: "open" | "in_review" | "completed" | "expired" | "purged";
  require_otp: boolean;
  reminders_sent: number;
  max_reminders: number;
  reminders_paused: boolean;
  next_reminder_at: string | null;
  purge_at: string | null;
  due_at: string | null;
  last_opened_at: string | null;
  is_demo: boolean;
  created_at: string;
  total_items: number;
  approved_items: number;
  submitted_items: number;
  rejected_items: number;
  portal_url: string;
}

export interface RequestsListResponse {
  requests: RequestSummaryDto[];
  kpis: {
    active: number;
    awaitingReview: number;
    needsRevision: number;
    completed: number;
  };
  storageBytes: number;
  activeCount: number;
  workspace: WorkspaceDto;
  hasDemoData: boolean;
  demoPortalUrl: string | null;
}

export interface UploadDto {
  id: string;
  original_name: string;
  canonical_name: string;
  detected_mime: string;
  size_bytes: number;
  sha256?: string;
  created_at: string;
}

export interface RequestItemDto {
  id: string;
  position: number;
  section: string;
  label: string;
  help_text: string;
  kind: ItemKind;
  required: boolean;
  validator: ValidatorKey;
  validator_hint?: string | null;
  config: {
    allowedGroups?: string[];
    maxFileMb?: number;
    multiple?: boolean;
    slug?: string;
  };
  status: "pending" | "submitted" | "rejected" | "approved";
  displayValue?: string | null;
  currentValue?: string | null;
  isSensitiveMasked: boolean;
  review_note: string | null;
  client_note?: string | null;
  client_na?: boolean;
  updated_at: string;
  uploads: UploadDto[];
}

export interface AuditEventDto {
  id: string;
  actor: string;
  action: string;
  meta_json: string;
  created_at: string;
}

export interface RequestDetailResponse {
  request: {
    id: string;
    title: string;
    client_name: string;
    client_email: string;
    client_subject: string | null;
    welcome_note: string | null;
    status: "open" | "in_review" | "completed" | "expired" | "purged";
    require_otp: boolean;
    reminders_sent: number;
    max_reminders: number;
    reminders_paused: boolean;
    next_reminder_at: string | null;
    purge_after_days: number;
    purge_at: string | null;
    due_at: string | null;
    last_opened_at: string | null;
    last_manual_reminder_at?: string | null;
    completed_at: string | null;
    is_demo: boolean;
    created_at: string;
  };
  portalUrl: string;
  items: RequestItemDto[];
  auditEvents: AuditEventDto[];
}

export interface TemplateDto {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
  items: TemplateItemSpec[];
  created_at: string;
}

export interface OutboxEmailDto {
  id: string;
  request_id: string | null;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  kind: string;
  is_demo: number;
  created_at: string;
}

export interface SettingsResponse {
  webhookUrl: string;
  webhookSecret: string;
  branding: BrandingDto;
  readiness: {
    masterKeyConfigured: boolean;
    storageBackend: string;
    emailBackend: string;
    emailFrom: string;
    cronIntervalMinutes: number;
    defaultPurgeDays: number;
    hasDemoData: boolean;
    storageBytes: number;
    outboxCount: number;
  };
}

export interface ClientPortalResponse {
  requiresOtp: boolean;
  workspaceName: string;
  branding: BrandingDto;
  request: {
    id: string;
    title: string;
    client_name: string;
    maskedEmail?: string;
    client_subject?: string | null;
    welcome_note?: string | null;
    status: "open" | "in_review" | "completed" | "expired" | "purged";
    due_at: string | null;
    completed_at?: string | null;
    purge_at?: string | null;
  };
  items?: RequestItemDto[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(hasBody && !(init?.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    body: formData,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new ApiError(data.error || `Upload failed (${res.status})`, res.status);
  }
  return data;
}

/** XHR upload so the UI can show real byte progress (fetch has no upload progress events). */
export function apiUploadWithProgress<T>(
  url: string,
  formData: FormData,
  onProgress: (loaded: number, total: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: { error?: string } & T;
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {} as { error?: string } & T;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Connection lost. Check your internet and try again.", 0));
    xhr.send(formData);
  });
}

export const VALIDATOR_OPTIONS: Array<{ value: ValidatorKey; label: string; short: string; hint?: string }> = [
  { value: "none", label: "None (any text)", short: "Text" },
  { value: "email", label: "Email address", short: "Email", hint: "name@company.com" },
  { value: "url", label: "Website URL (https://)", short: "URL", hint: "https://example.com" },
  { value: "phone_e164", label: "International phone (E.164)", short: "Phone", hint: "+44 20 7946 0958" },
  { value: "iban", label: "IBAN (mod-97)", short: "IBAN", hint: "GB82 WEST 1234 5698 7654 32" },
  { value: "au_phone_e164", label: "AU phone (+61 E.164)", short: "+61 Phone", hint: "0412 345 678" },
  { value: "au_abn_mod89", label: "ATO ABN (11-digit mod-89)", short: "ABN", hint: "51 824 753 556" },
  { value: "au_bsb", label: "Australian BSB (6-digit)", short: "BSB", hint: "062-000" },
  { value: "au_tfn_mod11", label: "ATO TFN (mod-11, masked)", short: "TFN", hint: "8 or 9 digits, stored masked" },
  { value: "au_medicare_mod10", label: "Medicare + IRN (mod-10, masked)", short: "Medicare", hint: "10 or 11 digits incl. IRN" },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const absMins = Math.round(Math.abs(diffMs) / 60_000);
  if (absMins < 1) return "just now";
  if (absMins < 60) return diffMs >= 0 ? `${absMins}m ago` : `in ${absMins}m`;
  const absHours = Math.round(absMins / 60);
  if (absHours < 48) return diffMs >= 0 ? `${absHours}h ago` : `in ${absHours}h`;
  const absDays = Math.round(absHours / 24);
  return diffMs >= 0 ? `${absDays}d ago` : `in ${absDays}d`;
}
