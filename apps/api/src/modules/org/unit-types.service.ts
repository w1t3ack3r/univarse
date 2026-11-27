// Spec 0042 Q1, Q2, Q-A3: the institution's unit types, edited one at a time. A type's key and kind never change; a
// type is archived, never deleted; a changed "may contain" applies to new placements and moves only.
import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { stale } from '../../shared/http/etag.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { INSTITUTION, PolicyService } from '../identity/policy.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

export interface UnitTypeView {
  id: string;
  key: string;
  name: string;
  kind: 'ACADEMIC' | 'ADMINISTRATIVE' | 'RESEARCH';
  status: 'ACTIVE' | 'ARCHIVED';
  sortOrder: number;
  mayContain: string[];
  units: number;
  version: number;
}

export interface SaveUnitType {
  readonly name: string;
  readonly kind: 'ACADEMIC' | 'ADMINISTRATIVE' | 'RESEARCH';
  readonly mayContain: readonly string[];
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly sortOrder?: number | undefined;
}

@Injectable()
export class UnitTypeService {
  constructor(
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
    private readonly policy: PolicyService,
  ) {}

  async list(
    tenant: TenantContext,
    actor: Actor,
  ): Promise<{ data: UnitTypeView[]; canManage: boolean }> {
    const data = await this.shards.tx(tenant.shardId, tenant.tenantId, (db) => this.views(db));
    return { data, canManage: this.policy.holds(actor, 'org.unit_type.manage', INSTITUTION) };
  }

  /** Q-A3: creates the type when `expected` is 0 and the key is new; otherwise edits it at that version. */
  async save(
    tenant: TenantContext,
    actor: Actor,
    key: string,
    expected: number,
    body: SaveUnitType,
    meta: SessionMeta,
  ): Promise<UnitTypeView> {
    if (!KEY.test(key)) throw new ProblemError(404, 'resource.not_found', 'Not found');
    await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      // One writer at a time for the institution's types: names are unique among them, and rules name each other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`unit-types:${tenant.tenantId}`}, 0))`;
      const all = await tx.unitType.findMany({
        select: {
          id: true,
          key: true,
          name: true,
          kind: true,
          status: true,
          sortOrder: true,
          version: true,
          contains: { select: { child: { select: { key: true } } } },
        },
      });
      const existing = all.find((t) => t.key === key);
      if ((existing?.version ?? 0) !== expected) throw stale();
      if (existing && existing.kind !== body.kind)
        throw new ProblemError(
          422,
          'org.unit_type.kind_fixed',
          'Kind fixed',
          'A unit type’s kind can’t change once it’s made.',
        );
      const name = body.name.trim();
      if (all.some((t) => t.key !== key && t.name.toLowerCase() === name.toLowerCase())) {
        throw new ProblemError(
          422,
          'org.unit_type.name_taken',
          'Name taken',
          'Another unit type already has that name.',
        );
      }
      const ids = new Map(all.map((t) => [t.key, t.id]));
      const children = [...new Set(body.mayContain)];
      // A new type may name itself ("a unit may contain units"); every other key must already exist.
      if (children.some((k) => k !== key && !ids.has(k)))
        throw new ProblemError(
          422,
          'org.unit_type.unknown_child',
          'Unknown type',
          'One of the types it may contain doesn’t exist.',
        );
      const sortOrder =
        body.sortOrder ?? existing?.sortOrder ?? Math.max(-1, ...all.map((t) => t.sortOrder)) + 1;
      const row = existing
        ? await tx.unitType.update({
            where: { id: existing.id },
            data: { name, status: body.status, sortOrder, version: existing.version + 1 },
            select: { id: true },
          })
        : await tx.unitType.create({
            data: {
              tenantId: tenant.tenantId,
              key,
              name,
              kind: body.kind,
              status: body.status,
              sortOrder,
            },
            select: { id: true },
          });
      ids.set(key, row.id);
      const before = existing ? existing.contains.map((c) => c.child.key).sort() : [];
      const after = children.sort();
      await tx.unitTypeRule.deleteMany({
        where: { parentTypeId: row.id, child: { key: { notIn: after } } },
      });
      const add = after.filter((k) => !before.includes(k));
      if (add.length > 0) {
        await tx.unitTypeRule.createMany({
          data: add.flatMap((k) => {
            const childTypeId = ids.get(k);
            return childTypeId ? [{ tenantId: tenant.tenantId, parentTypeId: row.id, childTypeId }] : [];
          }),
          skipDuplicates: true,
        });
      }
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'org.unit_type.saved',
        entityType: 'org_unit_type',
        entityId: row.id,
        before: existing
          ? {
              key,
              name: existing.name,
              status: existing.status,
              sortOrder: existing.sortOrder,
              mayContain: before,
              version: existing.version,
            }
          : null,
        after: {
          key,
          name,
          kind: body.kind,
          status: body.status,
          sortOrder,
          mayContain: after,
          version: (existing?.version ?? 0) + 1,
        },
        ...SessionService.auditMeta(meta),
      });
    });
    const view = (
      await this.shards.tx(tenant.shardId, tenant.tenantId, (db) => this.views(db))
    ).find((t) => t.key === key);
    if (!view) throw new Error('unit type vanished after its save');
    return view;
  }

  private async views(db: TenantTx): Promise<UnitTypeView[]> {
    const rows = await db.unitType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        kind: true,
        status: true,
        sortOrder: true,
        version: true,
        contains: { select: { child: { select: { key: true } } } },
        _count: { select: { units: true } },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      kind: t.kind,
      status: t.status,
      sortOrder: t.sortOrder,
      mayContain: t.contains.map((c) => c.child.key).sort(),
      units: t._count.units,
      version: t.version,
    }));
  }
}
