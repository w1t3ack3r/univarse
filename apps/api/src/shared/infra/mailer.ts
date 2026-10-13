import nodemailer from 'nodemailer';

export const MAILER = Symbol('MAILER');

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Stable id for receiver-side de-duplication of at-least-once delivery (spec 0002 B6). */
  readonly messageId?: string;
}

/** Port for transactional email (docs/15 §3). Adapters: SMTP (dev: Mailpit), provider API later. */
export interface Mailer {
  send(mail: OutboundEmail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    // Bounded so a stuck SMTP server can't hold the worker's transaction open (spec 0002 Part B).
    this.transport = nodemailer.createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
  }

  async send(mail: OutboundEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.messageId ? { messageId: mail.messageId } : {}),
    });
  }
}
