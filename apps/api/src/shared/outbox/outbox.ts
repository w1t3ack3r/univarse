// Transactional outbox (spec 0002 Part B). Side effects are enqueued in the business transaction
// and delivered by the worker; request paths never call SMTP (B1, B7).
import { Inject, Injectable } from '@nestjs/common';
import type { ProductKey } from '@univarse/contracts';
import type { TenantTx } from '@univarse/db';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { encryptField, keyringFromEnv, type FieldKeyring } from '../crypto/field-encryption.js';
import type { OutboundEmail } from '../infra/mailer.js';

export const EMAIL_EVENT = 'email.send';

/** Binds a ciphertext to its tenant and row: a payload copied onto another row won't decrypt (B2). */
export const outboxAad = (tenantId: string, eventId: string) => `${tenantId}:outbox:${eventId}`;

@Injectable()
export class Outbox {
  private readonly ring: FieldKeyring;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.ring = keyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY);
  }

  /** Enqueues an email in `tx`. If the transaction rolls back, the email never exists (B1). */
  async enqueueEmail(tx: TenantTx, tenantId: string, mail: OutboundEmail, product: ProductKey = 'core'): Promise<string> {
    const id = randomUUID();
    const plaintext = Buffer.from(JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text }), 'utf8');
    await tx.outboxEvent.create({
      data: { id, tenantId, type: EMAIL_EVENT, product, payloadEnc: encryptField(this.ring, plaintext, outboxAad(tenantId, id)) },
    });
    return id;
  }
}
