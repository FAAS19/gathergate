// Transactional client emails: plain-text first, table-based inline-styled HTML for broad client support.
import type { WorkspaceRow } from "../db/queries.js";

export interface EmailBrand {
  name: string;
  color: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
}

export function emailBrand(ws: WorkspaceRow, baseUrl: string): EmailBrand {
  return {
    name: ws.name,
    color: ws.brand_color,
    // Email clients block data: URIs, so logos are served from a public route.
    logoUrl: ws.logo_b64 ? `${baseUrl}/api/public/workspaces/${ws.id}/logo` : null,
    supportEmail: ws.support_email,
    supportPhone: ws.support_phone,
  };
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const DEFAULT_ACCENT = "#0F5243";
const INK = "#11181C";
const MUTED = "#5B6B66";
const HAIRLINE = "#E2E7E3";
const CANVAS = "#F8F9F7";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Picks white or ink text, whichever reads better on the accent. */
export function readableTextOn(hex: string): string {
  return contrastRatio(hex, "#FFFFFF") >= contrastRatio(hex, INK) ? "#FFFFFF" : INK;
}

function layout(params: {
  brand: EmailBrand;
  preheader: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
}): string {
  const accent = isHexColor(params.brand.color) ? params.brand.color : DEFAULT_ACCENT;
  const onAccent = readableTextOn(accent);
  const name = escapeHtml(params.brand.name);
  const header = params.brand.logoUrl
    ? `<img src="${escapeHtml(params.brand.logoUrl)}" alt="${name}" height="32" style="display:block;height:32px;max-width:200px;border:0;">`
    : `<span style="font-size:15px;font-weight:600;color:${INK};letter-spacing:-0.01em;">${name}</span>`;
  const cta = params.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;">
        <tr><td style="border-radius:8px;background:${accent};">
          <a href="${escapeHtml(params.cta.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${onAccent};text-decoration:none;border-radius:8px;">${escapeHtml(params.cta.label)}</a>
        </td></tr>
      </table>
      <p style="margin:12px 0 0;font-size:12px;line-height:18px;color:${MUTED};">Button not working? Paste this link into your browser:<br><a href="${escapeHtml(params.cta.url)}" style="color:${MUTED};word-break:break-all;">${escapeHtml(params.cta.url)}</a></p>`
    : "";
  const support = [params.brand.supportEmail, params.brand.supportPhone].filter(Boolean).map((v) => escapeHtml(v!));
  const supportLine = support.length
    ? `Questions? Contact ${name} at ${support.join(" or ")}.`
    : `Questions? Reply to ${name} directly.`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(params.heading)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(params.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 20px;">${header}</td></tr>
      <tr><td style="background:#FFFFFF;border:1px solid ${HAIRLINE};border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${INK};letter-spacing:-0.01em;">${escapeHtml(params.heading)}</h1>
        ${params.bodyHtml}
        ${cta}
      </td></tr>
      <tr><td style="padding:20px 4px 0;font-size:12px;line-height:18px;color:${MUTED};">
        ${supportLine}<br>No account or password needed. Files are encrypted when they arrive.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:${INK};">${html}</p>`;

function formatDue(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
}

export function inviteEmail(params: {
  brand: EmailBrand;
  clientName: string;
  title: string;
  portalUrl: string;
  itemCount: number;
  welcomeNote?: string | null;
  dueAt?: string | null;
  subject?: string | null;
}): RenderedEmail {
  const due = formatDue(params.dueAt);
  const subject = params.subject || `${params.brand.name} needs a few documents from you`;
  const items = `${params.itemCount} item${params.itemCount === 1 ? "" : "s"}`;
  const text = [
    `Hi ${params.clientName},`,
    "",
    `${params.brand.name} has asked for ${items} for "${params.title}".`,
    ...(params.welcomeNote ? ["", params.welcomeNote] : []),
    ...(due ? ["", `Please complete it by ${due}.`] : []),
    "",
    "Open your secure checklist (no account or password needed):",
    params.portalUrl,
  ].join("\n");
  const html = layout({
    brand: params.brand,
    preheader: `${items} requested for ${params.title}`,
    heading: params.title,
    bodyHtml: [
      p(`Hi ${escapeHtml(params.clientName)},`),
      p(`${escapeHtml(params.brand.name)} has asked for ${items}. Upload everything in one place, at your own pace. Your progress saves as you go.`),
      params.welcomeNote
        ? `<p style="margin:0 0 14px;padding:12px 14px;border-left:3px solid ${HAIRLINE};font-size:14px;line-height:22px;color:${MUTED};white-space:pre-line;">${escapeHtml(params.welcomeNote)}</p>`
        : "",
      due ? p(`Please complete it by <strong>${escapeHtml(due)}</strong>.`) : "",
    ].join(""),
    cta: { label: "Open checklist", url: params.portalUrl },
  });
  return { subject, text, html };
}

export function otpEmail(params: { brand: EmailBrand; clientName: string; title: string; code: string }): RenderedEmail {
  const subject = `${params.code} is your verification code`;
  const text = [
    `Hi ${params.clientName},`,
    "",
    `Use this code to open "${params.title}" from ${params.brand.name}:`,
    "",
    params.code,
    "",
    "It expires in 15 minutes. If you did not request it, you can ignore this email.",
  ].join("\n");
  const html = layout({
    brand: params.brand,
    preheader: `Your code is ${params.code}`,
    heading: "Your verification code",
    bodyHtml: [
      p(`Use this code to open <strong>${escapeHtml(params.title)}</strong>.`),
      `<p style="margin:20px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;line-height:36px;font-weight:600;letter-spacing:8px;color:${INK};">${escapeHtml(params.code)}</p>`,
      p(`<span style="color:${MUTED};font-size:13px;">It expires in 15 minutes. If you did not request it, you can ignore this email.</span>`),
    ].join(""),
  });
  return { subject, text, html };
}

export function revisionEmail(params: {
  brand: EmailBrand;
  clientName: string;
  title: string;
  itemLabel: string;
  note: string;
  portalUrl: string;
}): RenderedEmail {
  const subject = `One item needs another look: ${params.itemLabel}`;
  const text = [
    `Hi ${params.clientName},`,
    "",
    `${params.brand.name} reviewed "${params.itemLabel}" on "${params.title}" and asked for an update:`,
    "",
    params.note,
    "",
    "Everything else you sent is saved. Open your checklist to update this item:",
    params.portalUrl,
  ].join("\n");
  const html = layout({
    brand: params.brand,
    preheader: `Update needed for ${params.itemLabel}`,
    heading: "One item needs another look",
    bodyHtml: [
      p(`Hi ${escapeHtml(params.clientName)},`),
      p(`${escapeHtml(params.brand.name)} reviewed <strong>${escapeHtml(params.itemLabel)}</strong> and asked for an update:`),
      `<p style="margin:0 0 14px;padding:12px 14px;background:#FFF8EB;border:1px solid #F5D9A8;border-radius:8px;font-size:14px;line-height:22px;color:${INK};white-space:pre-line;">${escapeHtml(params.note)}</p>`,
      p("Everything else you sent is saved."),
    ].join(""),
    cta: { label: "Update item", url: params.portalUrl },
  });
  return { subject, text, html };
}

export function reminderEmail(params: {
  brand: EmailBrand;
  clientName: string;
  title: string;
  portalUrl: string;
  outstanding: Array<{ label: string; needsRevision: boolean; note?: string | null }>;
}): RenderedEmail {
  const count = params.outstanding.length;
  const subject = `Reminder: ${count} item${count === 1 ? "" : "s"} left for ${params.title}`;
  const text = [
    `Hi ${params.clientName},`,
    "",
    `A quick reminder from ${params.brand.name}. Still needed for "${params.title}":`,
    "",
    ...params.outstanding.map(
      (i) => `  - ${i.label}${i.needsRevision ? " (needs update)" : ""}${i.note ? `: ${i.note}` : ""}`
    ),
    "",
    "Open your secure checklist (no account or password needed):",
    params.portalUrl,
  ].join("\n");
  const rows = params.outstanding
    .map(
      (i) => `<tr><td style="padding:10px 0;border-top:1px solid ${HAIRLINE};font-size:14px;line-height:20px;color:${INK};">
        ${escapeHtml(i.label)}${i.needsRevision ? ` <span style="color:#B45309;font-size:12px;font-weight:600;">Needs update</span>` : ""}
        ${i.note ? `<br><span style="color:${MUTED};font-size:13px;">${escapeHtml(i.note)}</span>` : ""}
      </td></tr>`
    )
    .join("");
  const html = layout({
    brand: params.brand,
    preheader: `${count} item${count === 1 ? "" : "s"} still needed`,
    heading: `${count} item${count === 1 ? "" : "s"} left`,
    bodyHtml: [
      p(`Hi ${escapeHtml(params.clientName)}, a quick reminder from ${escapeHtml(params.brand.name)}. Still needed for <strong>${escapeHtml(params.title)}</strong>:`),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;border-bottom:1px solid ${HAIRLINE};">${rows}</table>`,
    ].join(""),
    cta: { label: "Continue checklist", url: params.portalUrl },
  });
  return { subject, text, html };
}
