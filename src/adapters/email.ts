import nodemailer from "nodemailer";
import type { AppConfig, EmailBackend } from "../config.js";
import type { WorkspaceRow } from "../db/queries.js";
import { decryptField } from "../security/crypto.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface WorkspaceEmailSecrets {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  resendApiKey?: string;
}

export interface ResolvedWorkspaceEmail {
  source: "workspace" | "env";
  backend: EmailBackend;
  from: string;
  replyTo: string;
  smtp?: AppConfig["smtp"];
  resendApiKey?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

export class MemoryEmailAdapter implements EmailAdapter {
  public readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class ConsoleEmailAdapter implements EmailAdapter {
  async send(msg: EmailMessage): Promise<void> {
    console.log(
      `[GatherGate Email Console]\nTo: ${msg.to}\nSubject: ${msg.subject}\n${msg.text}\n---`
    );
  }
}

class ResendEmailAdapter implements EmailAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": "GatherGate/1.0 (TensorForge; contact@tensorforge.dev)",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend API error (${res.status}): ${await res.text()}`);
    }
  }
}

class SmtpEmailAdapter implements EmailAdapter {
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    smtp: NonNullable<AppConfig["smtp"]>,
    private readonly from: string
  ) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 10_000,
    });
  }

  async send(msg: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
  }
}

export function createEmailAdapterFromOptions(opts: {
  backend: EmailBackend;
  from: string;
  resendApiKey?: string;
  smtp?: AppConfig["smtp"];
  fetchImpl?: typeof fetch;
}): EmailAdapter {
  if (opts.backend === "resend" && opts.resendApiKey) {
    return new ResendEmailAdapter(opts.resendApiKey, opts.from, opts.fetchImpl);
  }
  if (opts.backend === "smtp" && opts.smtp?.host) {
    return new SmtpEmailAdapter(opts.smtp, opts.from);
  }
  return new ConsoleEmailAdapter();
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  return createEmailAdapterFromOptions({
    backend: config.emailBackend,
    from: config.emailFrom,
    resendApiKey: config.resendApiKey,
    smtp: config.smtp,
  });
}

export function resolveWorkspaceEmail(
  ws: Pick<WorkspaceRow, "id" | "email_backend" | "email_from" | "email_reply_to" | "email_config_encrypted">,
  config: AppConfig,
  masterKey: Buffer
): ResolvedWorkspaceEmail {
  if (ws.email_backend === "console" || ws.email_backend === "smtp" || ws.email_backend === "resend") {
    let secrets: WorkspaceEmailSecrets = {};
    if (ws.email_config_encrypted) {
      try {
        secrets = JSON.parse(decryptField(masterKey, ws.email_config_encrypted, `${ws.id}:email`)) as WorkspaceEmailSecrets;
      } catch {
        secrets = {};
      }
    }
    return {
      source: "workspace",
      backend: ws.email_backend,
      from: ws.email_from || config.emailFrom,
      replyTo: ws.email_reply_to || "",
      smtp: secrets.smtpHost
        ? {
            host: secrets.smtpHost,
            port: secrets.smtpPort ?? 587,
            secure: Boolean(secrets.smtpSecure),
            user: secrets.smtpUser || "",
            pass: secrets.smtpPass || "",
          }
        : undefined,
      resendApiKey: secrets.resendApiKey,
    };
  }

  return {
    source: "env",
    backend: config.emailBackend,
    from: config.emailFrom,
    replyTo: "",
    smtp: config.smtp,
    resendApiKey: config.resendApiKey,
  };
}
