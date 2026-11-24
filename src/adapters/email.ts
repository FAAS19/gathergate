import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
    private readonly from: string
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": "GatherGate/0.1 (TensorForge; contact@tensorforge.dev)",
      },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
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
    });
  }

  async send(msg: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  if (config.emailBackend === "resend" && config.resendApiKey) {
    return new ResendEmailAdapter(config.resendApiKey, config.emailFrom);
  }
  if (config.emailBackend === "smtp" && config.smtp) {
    return new SmtpEmailAdapter(config.smtp, config.emailFrom);
  }
  return new ConsoleEmailAdapter();
}
