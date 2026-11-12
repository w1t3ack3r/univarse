// Spec 0033: the tenant registry. What the console may read about an institution, and the four things it may change.
// Every read names its columns: the role's grants are by column, so a `select *` would fail, and that's the point
// (Q3). Every change and its audit row commit together. The tenant is always from the path, and an unknown one is 404.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ALWAYS_ON, DEFAULT_PAGE_LIMIT, isProduct, PRODUCTS, type PlatformOps } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { checkLogo, registryWritable, regulatorForType, textColorOn, typeMayChange, type LogoProblem } from '@univarse/domain';
import type { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';
import { stale } from '../../shared/http/etag.js';
import { platformAudit, type PlatformAuditInput } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

type ListQuery = z.infer<typeof PlatformOps.tenants.query>;
type ListResponse = z.infer<typeof PlatformOps.tenants.response>;
type Detail = z.infer<typeof PlatformOps.tenant.response>;
type ProfileBody = z.infer<typeof PlatformOps.tenantProfile.body>;
type RegulatoryBody = z.infer<typeof PlatformOps.tenantRegulatory.body>;
type ProductBody = z.infer<typeof PlatformOps.tenantProduct.body>;

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const badCursor = () => new ProblemError(400, 'request.invalid_cursor', 'Invalid cursor');
const closed = () => new ProblemError(409, 'tenant.closed', 'This institution is archived');
const LOGO_REFUSED: Readonly<Record<LogoProblem, string>> = {
  too_large: 'The logo must be 256 KB or smaller',
  not_png_or_webp: 'The logo must be a PNG or WebP image',
  too_many_pixels: 'The logo must be 1024 × 1024 pixels or smaller',
};

/** Prisma's `contains` passes `%` and `_` through as wildcards: a search for a percent sign means a percent sign. */
const literal = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

const SUMMARY = { id: true, slug: true, legalName: true, shortName: true, type: true, ownership: true, status: true, tier: true } as const;

/** Which fields a profile edit changed, as the audit's before and after. */
function diff<T extends object>(before: T, after: T): { before: Partial<T>; after: Partial<T> } | null {
  const keys = (Object.keys(after) as (keyof T)[]).filter((k) => before[k] !== after[k]);
  if (keys.length === 0) return null;
  return { before: Object.fromEntries(keys.map((k) => [k, before[k]])) as Partial<T>, after: Object.fromEntries(keys.map((k) => [k, after[k]])) as Partial<T> };
}

@Injectable()
export class TenantRegistry {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  private audit(tx: PlatformTx, actor: PlatformActor, tenantId: string, action: PlatformAuditInput['action'], metadata: Record<string, unknown>, meta: RequestMeta) {
    return platformAudit(tx, { actorId: actor.userId, tenantId, action, metadata }, meta);
  }

  /** Q2, Q8: by legal name, then id; a page at a time. */
  async list(q: ListQuery): Promise<ListResponse> {
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    let after: { id: string; legalName: string } | null = null;
    if (q.cursor) {
      const id = decodeCursor(q.cursor);
      after = id ? await this.db.tenant.findUnique({ where: { id }, select: { id: true, legalName: true } }) : null;
      if (!after) throw badCursor();
    }
    const term = q.q ? literal(q.q) : null;
    const rows = await this.db.tenant.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        AND: [
          term
            ? {
                OR: [
                  { legalName: { contains: term, mode: 'insensitive' as const } },
                  { shortName: { contains: term, mode: 'insensitive' as const } },
                  { slug: { contains: term, mode: 'insensitive' as const } },
                  { domains: { some: { hostname: { contains: term, mode: 'insensitive' as const } } } },
                ],
              }
            : {},
          after ? { OR: [{ legalName: { gt: after.legalName } }, { legalName: after.legalName, id: { gt: after.id } }] } : {},
        ],
      },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: SUMMARY,
    });
    const data = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = data.at(-1);
    return { data, page: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, limit, hasMore } };
  }

  async detail(id: string): Promise<Detail> {
    const t = await this.db.tenant.findUnique({
      where: { id },
      select: {
        ...SUMMARY,
        version: true,
        suspendedReason: true,
        template: true,
        createdAt: true,
        updatedAt: true,
        shard: { select: { name: true, kind: true, region: true } },
        domains: { select: { hostname: true, kind: true, verifiedAt: true }, orderBy: { hostname: 'asc' } },
        products: { select: { product: true, entitled: true, enabled: true } },
        dataKeys: { select: { version: true, status: true, createdAt: true, retiredAt: true, destroyedAt: true }, orderBy: { version: 'desc' } },
      },
    });
    if (!t) throw notFound();
    const [regulatory, branding] = await Promise.all([
      this.db.tenantRegulatoryProfile.findUnique({ where: { tenantId: id }, select: { operatingStatus: true, state: true, regulatorReference: true, jambCode: true, version: true } }),
      this.db.tenantBranding.findUnique({ where: { tenantId: id }, select: { primaryColor: true, logoSha256: true } }),
    ]);
    const flags = new Map(t.products.map((p) => [p.product, p]));
    const primary = branding?.primaryColor ?? null;
    return {
      id: t.id,
      slug: t.slug,
      legalName: t.legalName,
      shortName: t.shortName,
      type: t.type,
      ownership: t.ownership,
      status: t.status,
      tier: t.tier,
      version: t.version,
      suspendedReason: t.suspendedReason,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      typeLocked: !typeMayChange(t.status),
      shard: t.shard,
      domains: t.domains.map((d) => ({ hostname: d.hostname, kind: d.kind, verifiedAt: d.verifiedAt?.toISOString() ?? null })),
      products: PRODUCTS.map((product) => {
        const always = ALWAYS_ON.includes(product);
        const row = flags.get(product);
        return { product, alwaysOn: always, entitled: always || (row?.entitled ?? false), enabled: always || (row?.enabled ?? false) };
      }),
      keys: t.dataKeys.map((k) => ({ version: k.version, status: k.status, createdAt: k.createdAt.toISOString(), retiredAt: k.retiredAt?.toISOString() ?? null, destroyedAt: k.destroyedAt?.toISOString() ?? null })),
      regulatory: {
        regulator: regulatorForType(t.type),
        operatingStatus: regulatory?.operatingStatus ?? 'UNKNOWN',
        state: regulatory?.state ?? null,
        regulatorReference: regulatory?.regulatorReference ?? null,
        jambCode: regulatory?.jambCode ?? null,
        version: regulatory?.version ?? 0,
      },
      branding: { primaryColor: primary, textColor: primary ? textColorOn(primary) : null, logoSha256: branding?.logoSha256 ?? null },
      template: t.template,
    };
  }

  /** The tenant, locked for this change, or 404. An archived or purged one takes no change at all. */
  private async writable(tx: PlatformTx, id: string) {
    const t = await tx.tenant.findUnique({ where: { id }, select: { id: true, slug: true, status: true, version: true, legalName: true, shortName: true, ownership: true, type: true } });
    if (!t) throw notFound();
    if (!registryWritable(t.status)) throw closed();
    return t;
  }

  /** Q5, Q6: `If-Match` on the row's version. The slug isn't in the contract, so no route can change it. */
  async editProfile(actor: PlatformActor, id: string, expected: number, body: ProfileBody, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const t = await this.writable(tx, id);
      if (t.version !== expected) throw stale();
      if (body.type !== t.type && !typeMayChange(t.status)) throw new ProblemError(409, 'tenant.type_locked', 'The type can’t change once an institution is live');
      const changed = diff({ legalName: t.legalName, shortName: t.shortName, ownership: t.ownership, type: t.type }, body);
      if (!changed) return;
      const n = await tx.tenant.updateMany({ where: { id, version: expected }, data: { ...body, version: { increment: 1 } } });
      if (n.count !== 1) throw stale();
      await this.audit(tx, actor, id, 'platform.tenant.profile_changed', changed, meta);
    });
  }

  /** Q7: the regulator isn't stored: it follows the type. */
  async editRegulatory(actor: PlatformActor, id: string, expected: number, body: RegulatoryBody, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.writable(tx, id);
      const row = await tx.tenantRegulatoryProfile.findUnique({ where: { tenantId: id }, select: { operatingStatus: true, state: true, regulatorReference: true, jambCode: true, version: true } });
      if ((row?.version ?? 0) !== expected) throw stale();
      const { version: _v, ...current } = row ?? { operatingStatus: 'UNKNOWN', state: null, regulatorReference: null, jambCode: null, version: 0 };
      const changed = diff<Record<string, unknown>>(current, body);
      if (!changed) return;
      if (row) {
        const n = await tx.tenantRegulatoryProfile.updateMany({ where: { tenantId: id, version: expected }, data: { ...body, version: { increment: 1 }, updatedBy: actor.userId } });
        if (n.count !== 1) throw stale();
      } else {
        await tx.tenantRegulatoryProfile.create({ data: { tenantId: id, ...body, updatedBy: actor.userId }, select: { tenantId: true } });
      }
      await this.audit(tx, actor, id, 'platform.tenant.regulatory_changed', changed, meta);
    });
  }

  /** Q10. An absolute value: the last writer wins, and the audit log shows both. */
  async setColor(actor: PlatformActor, id: string, primaryColor: string | null, meta: RequestMeta): Promise<void> {
    if (primaryColor !== null && textColorOn(primaryColor) === null) {
      throw Object.assign(new ProblemError(422, 'tenant.color_contrast', 'That colour can’t carry readable text'), { errors: [{ path: 'primaryColor', code: 'contrast', message: 'Neither white nor the brand ink reaches 4.5:1 on this colour' }] });
    }
    await this.db.$transaction(async (tx) => {
      await this.writable(tx, id);
      const row = await tx.tenantBranding.findUnique({ where: { tenantId: id }, select: { primaryColor: true } });
      if ((row?.primaryColor ?? null) === primaryColor) return;
      await tx.tenantBranding.upsert({ where: { tenantId: id }, create: { tenantId: id, primaryColor, updatedBy: actor.userId }, update: { primaryColor, updatedBy: actor.userId }, select: { tenantId: true } });
      await this.audit(tx, actor, id, 'platform.tenant.branding_changed', { before: { primaryColor: row?.primaryColor ?? null }, after: { primaryColor } }, meta);
    });
  }

  /** Q9, Q16: judged from the bytes; the audit row holds the hash, never the bytes. */
  async setLogo(actor: PlatformActor, id: string, base64: string, meta: RequestMeta): Promise<void> {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    const check = checkLogo(bytes);
    if (!check.ok) throw Object.assign(new ProblemError(422, 'tenant.logo_refused', LOGO_REFUSED[check.problem]), { errors: [{ path: 'logo', code: check.problem, message: LOGO_REFUSED[check.problem] }] });
    const logoSha256 = createHash('sha256').update(bytes).digest('hex');
    await this.db.$transaction(async (tx) => {
      await this.writable(tx, id);
      const row = await tx.tenantBranding.findUnique({ where: { tenantId: id }, select: { logoSha256: true } });
      if (row?.logoSha256 === logoSha256) return;
      const data = { logo: bytes, logoMime: check.mime, logoSha256, updatedBy: actor.userId };
      await tx.tenantBranding.upsert({ where: { tenantId: id }, create: { tenantId: id, ...data }, update: data, select: { tenantId: true } });
      await this.audit(tx, actor, id, 'platform.tenant.branding_changed', { before: { logoSha256: row?.logoSha256 ?? null }, after: { logoSha256 } }, meta);
    });
  }

  async removeLogo(actor: PlatformActor, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.writable(tx, id);
      const row = await tx.tenantBranding.findUnique({ where: { tenantId: id }, select: { logoSha256: true } });
      if (!row?.logoSha256) return;
      await tx.tenantBranding.update({ where: { tenantId: id }, data: { logo: null, logoMime: null, logoSha256: null, updatedBy: actor.userId }, select: { tenantId: true } });
      await this.audit(tx, actor, id, 'platform.tenant.branding_changed', { before: { logoSha256: row.logoSha256 }, after: { logoSha256: null } }, meta);
    });
  }

  /** The console's preview. Only ever this institution's own stored image. */
  async logo(id: string): Promise<{ bytes: Uint8Array; mime: string; sha256: string }> {
    const row = await this.db.tenantBranding.findUnique({ where: { tenantId: id }, select: { logo: true, logoMime: true, logoSha256: true } });
    if (!row?.logo || !row.logoMime || !row.logoSha256) throw notFound();
    return { bytes: row.logo, mime: row.logoMime, sha256: row.logoSha256 };
  }

  /**
   * Q13, Q14: revoking also switches it off, in one statement, as the table's check requires. It hides a product and
   * deletes nothing. A no-op changes nothing and records nothing (spec 0003).
   */
  async setEntitlement(actor: PlatformActor, id: string, product: string, body: ProductBody, meta: RequestMeta): Promise<void> {
    if (!isProduct(product)) throw notFound();
    if (ALWAYS_ON.includes(product)) throw new ProblemError(409, 'tenant.product_always_on', 'Core is always on');
    await this.db.$transaction(async (tx) => {
      const t = await this.writable(tx, id);
      if (!body.entitled && body.confirmSlug !== t.slug) throw new ProblemError(422, 'tenant.confirm_mismatch', 'Type the institution’s subdomain to confirm');
      const row = await tx.tenantProduct.findUnique({ where: { tenantId_product: { tenantId: id, product } }, select: { entitled: true, enabled: true } });
      if ((row?.entitled ?? false) === body.entitled) return;
      const data = { entitled: body.entitled, ...(body.entitled ? {} : { enabled: false }), updatedBy: actor.userId };
      await tx.tenantProduct.upsert({ where: { tenantId_product: { tenantId: id, product } }, create: { tenantId: id, product, ...data }, update: data, select: { id: true } });
      await this.audit(tx, actor, id, body.entitled ? 'platform.tenant.product_granted' : 'platform.tenant.product_revoked', { product, reason: body.reason, wasEnabled: row?.enabled ?? false }, meta);
    });
  }
}
