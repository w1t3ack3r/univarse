// Spec 0028 Q15: every console action is audited in its own transaction, on the platform's hash chain. Ids only:
// a member's email or name never goes into the metadata (spec 0026 T26), and neither does any credential.
import { writePlatformAudit } from '@univarse/crypto';
import type { PlatformTx, RequestMeta } from './types.js';

export interface PlatformAuditInput {
  /** The member who acted, or null for the owner's command line (Q5). */
  readonly actorId: string | null;
  readonly action: `platform.${string}`;
  readonly metadata?: Record<string, unknown>;
}

export async function platformAudit(tx: PlatformTx, e: PlatformAuditInput, meta?: RequestMeta): Promise<void> {
  await writePlatformAudit(tx, {
    actorId: e.actorId,
    action: e.action,
    tenantId: null,
    metadata: { ...(e.metadata ?? {}), ...(meta?.requestId ? { requestId: meta.requestId } : {}) },
    ip: meta?.ip ?? null,
  });
}
