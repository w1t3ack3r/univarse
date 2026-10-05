// Tenant settings (spec 0007). Core's published contract for every product: `get(tenant, key)`
// returns the typed effective value (ST12). Nothing else reads the `setting` table.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SETTINGS,
  type SettingDef,
  type SettingKey,
  type SettingValue,
  type SettingView,
} from '@univarse/contracts';
import { TenantModels } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { requireIfMatch, stale } from '../../shared/http/etag.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { enforcePermission } from '../identity/access.guard.js';
import { canInstitutionWide, type Actor } from '../identity/actor.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';
import { ProductService } from '../products/product.service.js';
import { cacheKey, SettingsCache, type CachedSetting } from './settings-cache.js';

/** The registry in use. Production: `SETTINGS`. Tests add keys to prove scoping rules. */
export const SETTINGS_REGISTRY = Symbol('SETTINGS_REGISTRY');
export type SettingsRegistry = Readonly<Record<string, SettingDef>>;

/** First slice: institution scope only (faculty/programme overrides: Phase 4). */
const SCOPE = 'INSTITUTION';
const REDACTED = '[redacted]';

export interface TenantRef {
  readonly tenantId: string;
  readonly shardId: string;
}

class InvalidSettingValue extends ProblemError {
  constructor(readonly errors: { path: string; code: string; message: string }[]) {
    super(422, 'settings.invalid_value', 'Invalid setting value');
  }
}

const unknownKey = () => new ProblemError(404, 'settings.unknown_key', 'Unknown setting');

@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');
  private readonly orphansReported = new Set<string>();

  constructor(
    private readonly shards: ShardRegistry,
    private readonly products: ProductService,
    private readonly audit: AuditWriter,
    private readonly cache: SettingsCache,
    @Inject(SETTINGS_REGISTRY) private readonly registry: SettingsRegistry,
  ) {}

  /** ST12: the typed effective value. Callers are already inside their own product's guard. */
  async get<K extends SettingKey>(tenant: TenantRef, key: K): Promise<SettingValue<K>> {
    const def = this.def(key);
    const e = await this.entry(tenant, key, def);
    return (e.value ?? def.default) as SettingValue<K>;
  }

  /** ST5: the keys this user may see (view permission is checked by the route), of active products. */
  async list(tenant: TenantContext, actor: Actor): Promise<SettingView[]> {
    void this.reportOrphans(tenant);
    const views: SettingView[] = [];
    for (const key of Object.keys(this.registry)) {
      const def = this.def(key);
      if (await this.products.isActive(tenant.tenantId, def.product)) views.push(await this.toView(tenant, actor, key, def));
    }
    return views;
  }

  async view(tenant: TenantContext, actor: Actor, key: string): Promise<SettingView> {
    const def = await this.visibleDef(tenant, key);
    return this.toView(tenant, actor, key, def);
  }

  /** ST3/ST4/ST6/ST8: validated, authorised, version-checked, audited in the same transaction. */
  async update(tenant: TenantContext, actor: Actor, key: string, raw: unknown, ifMatch: string | undefined, meta: SessionMeta): Promise<SettingView> {
    const def = await this.visibleDef(tenant, key);
    enforcePermission(actor, def.manage);
    const expected = requireIfMatch(ifMatch);
    const value = this.validate(def, raw);
    return this.write(tenant, actor, key, def, expected, value, meta);
  }

  /** ST7: back to the registry default. The row stays (value NULL) so versions never repeat. */
  async reset(tenant: TenantContext, actor: Actor, key: string, ifMatch: string | undefined, meta: SessionMeta): Promise<SettingView> {
    const def = await this.visibleDef(tenant, key);
    enforcePermission(actor, def.manage);
    const expected = requireIfMatch(ifMatch);
    return this.write(tenant, actor, key, def, expected, null, meta);
  }

  private async write(
    tenant: TenantContext,
    actor: Actor,
    key: string,
    def: SettingDef,
    expected: number,
    value: unknown,
    meta: SessionMeta,
  ): Promise<SettingView> {
    const { tenantId, shardId } = tenant;
    let version: number;
    try {
      version = await this.shards.tx(shardId, tenantId, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; version: number; value: unknown }[]>`
          SELECT id::text, version, value FROM setting
          WHERE tenant_id = ${tenantId}::uuid AND key = ${key} AND scope_key = ${SCOPE} FOR UPDATE`;
        const row = rows[0];
        if ((row?.version ?? 0) !== expected) throw stale();
        const before = row?.value ?? null;
        if (row && before === null && value === null) return row.version; // already on the default
        const next = expected + 1;
        const saved = row
          ? await tx.setting.update({ where: { id: row.id }, data: { value: this.json(value), version: next, updatedBy: actor.userId } })
          : await tx.setting.create({ data: { tenantId, key, scopeKey: SCOPE, value: this.json(value), version: next, updatedBy: actor.userId } });
        await this.audit.write(tx, tenantId, {
          actorType: 'USER',
          actorId: actor.userId,
          action: value === null ? 'settings.reset' : 'settings.updated',
          entityType: 'setting',
          entityId: saved.id,
          before: { key, scope: SCOPE, value: this.forAudit(def, before), version: expected },
          after: { key, scope: SCOPE, value: this.forAudit(def, value), version: next },
          ...SessionService.auditMeta(meta),
        });
        return next;
      });
    } catch (err) {
      // Two first writes racing: the loser hits the unique (tenant, key, scope) and is simply stale.
      if ((err as { code?: string }).code === 'P2002') throw stale();
      throw err;
    }
    await this.cache.publish({ tenantId, scopeKey: SCOPE, key, version });
    return this.toView(tenant, actor, key, def);
  }

  /** Cached or loaded. A load only caches if no invalidation arrived while it ran (ST11c). */
  private async entry(tenant: TenantRef, key: string, def: SettingDef): Promise<CachedSetting> {
    const id = cacheKey(tenant.tenantId, SCOPE, key);
    const hit = this.cache.get(id);
    if (hit) return hit;
    const generation = this.cache.generation(id);
    const loaded = await this.load(tenant, key, def);
    this.cache.setIfUnchanged(id, generation, loaded);
    return loaded;
  }

  /** ST3: a stored value that no longer validates fails closed; it is never swapped for the default. */
  protected async load(tenant: TenantRef, key: string, def: SettingDef): Promise<CachedSetting> {
    const row = await (await this.shards.forTenant(tenant.shardId, tenant.tenantId)).setting.findUnique({
      where: { tenantId_key_scopeKey: { tenantId: tenant.tenantId, key, scopeKey: SCOPE } },
    });
    const value = row?.value ?? null;
    if (value !== null && !def.schema.safeParse(value).success) {
      this.logger.error({ tenantId: tenant.tenantId, key }, 'Stored setting value fails its schema');
      throw new ProblemError(500, 'settings.stored_value_invalid', 'Stored setting value is invalid');
    }
    return { value, version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null, updatedById: row?.updatedBy ?? null };
  }

  private async toView(tenant: TenantContext, actor: Actor, key: string, def: SettingDef): Promise<SettingView> {
    const e = await this.entry(tenant, key, def);
    const user = e.updatedById
      ? await (await this.shards.forTenant(tenant.shardId, tenant.tenantId)).userAccount.findUnique({
          where: { id: e.updatedById },
          select: { id: true, displayName: true },
        })
      : null;
    return {
      key: key as SettingKey,
      label: def.label,
      value: (e.value ?? def.default) as SettingView['value'],
      default: def.default as SettingView['default'],
      source: e.value === null ? 'default' : 'tenant',
      version: e.version,
      updatedAt: e.updatedAt?.toISOString() ?? null,
      updatedBy: user,
      canManage: canInstitutionWide(actor, def.manage),
    };
  }

  private def(key: string): SettingDef {
    const def = Object.hasOwn(this.registry, key) ? this.registry[key] : undefined;
    if (!def) throw unknownKey();
    return def;
  }

  /** ST1 + spec 0003: unknown keys and keys of inactive products are both 404. */
  private async visibleDef(tenant: TenantContext, key: string): Promise<SettingDef> {
    const def = this.def(key);
    if (!(await this.products.isActive(tenant.tenantId, def.product))) throw unknownKey();
    return def;
  }

  private validate(def: SettingDef, raw: unknown): unknown {
    const r = def.schema.safeParse(raw);
    if (r.success) return r.data;
    throw new InvalidSettingValue(r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })));
  }

  private forAudit(def: SettingDef, value: unknown): unknown {
    return def.sensitive && value !== null ? REDACTED : value;
  }

  private json(value: unknown) {
    return value === null ? TenantModels.Prisma.DbNull : (value as TenantModels.Prisma.InputJsonValue);
  }

  /** ST1: rows for keys no longer registered are ignored by reads, and reported once per process. */
  private async reportOrphans(tenant: TenantRef): Promise<void> {
    if (this.orphansReported.has(tenant.tenantId)) return;
    this.orphansReported.add(tenant.tenantId);
    try {
      const rows = await (await this.shards.forTenant(tenant.shardId, tenant.tenantId)).setting.findMany({ select: { key: true } });
      const orphans = [...new Set(rows.map((r) => r.key).filter((k) => !Object.hasOwn(this.registry, k)))];
      if (orphans.length > 0) this.logger.warn({ tenantId: tenant.tenantId, keys: orphans }, 'Stored settings with unregistered keys are ignored');
    } catch (err) {
      this.logger.warn({ tenantId: tenant.tenantId, error: (err as Error).name }, 'Orphan settings check failed');
    }
  }
}

/** The production registry provider. */
export const settingsRegistryProvider = { provide: SETTINGS_REGISTRY, useValue: SETTINGS satisfies SettingsRegistry };
