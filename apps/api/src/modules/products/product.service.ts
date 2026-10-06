import { Inject, Injectable, Logger } from '@nestjs/common';
import { ALWAYS_ON, isProduct, PRODUCTS, type ProductKey } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';

export interface ProductState {
  readonly product: ProductKey;
  readonly entitled: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
}

const alwaysOn = (p: ProductKey) => ALWAYS_ON.includes(p);

/**
 * Product entitlements (ADR-020, spec 0003). Rows live in the platform DB; the tenant comes
 * from the Host (P8) and is the only key used. Entitlements are never written here (P9).
 */
@Injectable()
export class ProductService {
  private readonly cache = new Map<string, { value: ReadonlySet<ProductKey>; expiresAt: number }>();
  private readonly logger = new Logger('Products');

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly shards: ShardRegistry,
    private readonly auditWriter: AuditWriter,
  ) {}

  /** P1/P7: active = entitled AND enabled, plus always-on products. Cached per tenant. */
  async active(tenantId: string): Promise<ReadonlySet<ProductKey>> {
    const now = Date.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > now) return hit.value;

    const rows = await this.platform.tenantProduct.findMany({
      where: { tenantId, entitled: true, enabled: true },
      select: { product: true },
    });
    const value = new Set<ProductKey>([...ALWAYS_ON, ...rows.map((r) => r.product).filter(isProduct)]);
    this.cache.set(tenantId, { value, expiresAt: now + this.config.TENANT_CACHE_TTL_MS });
    return value;
  }

  async isActive(tenantId: string, product: ProductKey): Promise<boolean> {
    return alwaysOn(product) || (await this.active(tenantId)).has(product);
  }

  /** P6: every catalog product with its flags. A missing row means not entitled. */
  async overview(tenantId: string): Promise<ProductState[]> {
    const rows = await this.platform.tenantProduct.findMany({ where: { tenantId } });
    const byKey = new Map(rows.map((r) => [r.product, r]));
    return PRODUCTS.map((product) => {
      const row = byKey.get(product);
      return state(product, row?.entitled ?? false, row?.enabled ?? false);
    });
  }

  /**
   * P4/P5. Platform row first, then the tenant audit event; if the audit write fails the platform
   * change is compensated and the request fails, so no unaudited change remains (design note).
   * Setting the current value again is a no-op and writes no event.
   */
  async setEnabled(tenant: TenantContext, actor: Actor, product: string, enabled: boolean, meta: SessionMeta): Promise<ProductState> {
    if (!isProduct(product)) throw new ProblemError(404, 'resource.not_found', 'Not found');
    if (alwaysOn(product)) {
      if (!enabled) throw new ProblemError(422, 'product.core_required', 'This product is always on');
      return state(product, true, true);
    }

    const tenantId = tenant.tenantId;
    const row = await this.platform.tenantProduct.findUnique({ where: { tenantId_product: { tenantId, product } } });
    if (!row?.entitled) {
      if (enabled) throw notEntitled();
      return state(product, false, row?.enabled ?? false);
    }
    if (row.enabled === enabled) return state(product, true, enabled);

    // Conditional: loses cleanly to a concurrent toggle or a concurrent entitlement revocation.
    const changed = await this.platform.tenantProduct.updateMany({
      where: { id: row.id, enabled: row.enabled, ...(enabled ? { entitled: true } : {}) },
      data: { enabled, updatedBy: actor.userId },
    });
    if (changed.count === 0) {
      throw new ProblemError(409, 'product.changed', 'Product settings changed', 'Reload and try again.');
    }

    try {
      await this.shards.tx(tenant.shardId, tenantId, (tx) =>
        this.auditWriter.write(tx, tenantId, {
          actorType: 'USER',
          actorId: actor.userId,
          action: enabled ? 'settings.product.enabled' : 'settings.product.disabled',
          entityType: 'tenant_product',
          entityId: row.id,
          before: { product, enabled: row.enabled },
          after: { product, enabled },
          ...SessionService.auditMeta(meta),
        }),
      );
    } catch (err) {
      await this.compensate(row.id, enabled, row.enabled, row.updatedBy);
      throw err;
    } finally {
      this.invalidate(tenantId);
    }
    return state(product, true, enabled);
  }

  /** P7: local invalidation. Other instances converge within the TTL (tracked gap). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async compensate(id: string, from: boolean, to: boolean, updatedBy: string | null): Promise<void> {
    try {
      await this.platform.tenantProduct.updateMany({ where: { id, enabled: from }, data: { enabled: to, updatedBy } });
    } catch (err) {
      // Residual risk: both databases failing in sequence. Loud, so operations can reconcile.
      this.logger.error({ event: 'products.compensation_failed', tenantProductId: id, err }, 'Compensation failed: product change is unaudited');
    }
  }
}

const notEntitled = () =>
  new ProblemError(409, 'product.not_entitled', 'Not included in your plan', 'Contact UniVarse to add this product to your plan.');

const state = (product: ProductKey, entitled: boolean, enabled: boolean): ProductState => ({
  product,
  entitled: alwaysOn(product) || entitled,
  enabled: alwaysOn(product) || enabled,
  active: alwaysOn(product) || (entitled && enabled),
});
