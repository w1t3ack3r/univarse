import nodemailer from 'nodemailer';

export const MAILER = Symbol('MAILER');

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
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
    this.transport = nodemailer.createTransport(url);
  }

  async send(mail: OutboundEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}
