// Spec 0041 Q4, Q5: an institution's copy of its institution-type profile, as it was assigned. One row per template
// version, written once: assigning again finds it and changes nothing. The content hash is SHA-256 of the profile's
// canonical JSON (the domain's `canonicalJson`); the platform's `tenant_profile_assignment` holds the same one.
import { createHash } from 'node:crypto';
import type { TenantTx } from './tenant.js';

/** SHA-256 of the profile's canonical JSON, lower-case hex. */
export function profileContentHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The same template version already holds a different profile: a content change without a new version (Q11). */
export class ProfileHashMismatch extends Error {
  constructor() {
    super('the institution already holds a different profile under this template version');
    this.name = 'ProfileHashMismatch';
  }
}

export type ProfileSourceName = 'PROVISIONING' | 'SEED' | 'BACKFILL';

export interface ProfileSnapshot {
  readonly template: string;
  readonly templateVersion: number;
  /** The profile as canonical JSON; stored as `jsonb`, hashed as these exact bytes. */
  readonly canonical: string;
  readonly source: ProfileSourceName;
}

/**
 * Writes the snapshot in `tx` (already scoped to `tenantId`) unless that template version is there. Returns whether
 * it wrote one, and the hash. A row there with another hash is refused, never overwritten: the snapshot is append-only.
 */
export async function recordProfileSnapshot(tx: TenantTx, tenantId: string, s: ProfileSnapshot): Promise<{ created: boolean; contentHash: string }> {
  const contentHash = profileContentHash(s.canonical);
  const where = { tenantId_template_templateVersion: { tenantId, template: s.template, templateVersion: s.templateVersion } };
  const existing = await tx.institutionProfile.findUnique({ where, select: { contentHash: true } });
  if (existing) {
    if (existing.contentHash !== contentHash) throw new ProfileHashMismatch();
    return { created: false, contentHash };
  }
  await tx.institutionProfile.create({
    data: { tenantId, template: s.template, templateVersion: s.templateVersion, contentHash, profile: JSON.parse(s.canonical) as object, source: s.source },
    select: { id: true },
  });
  return { created: true, contentHash };
}
