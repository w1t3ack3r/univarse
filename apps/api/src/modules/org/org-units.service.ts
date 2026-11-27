// Spec 0042 (P2-S1): the org tree's use cases. Each write runs in one transaction: the unit's row locked, its version
// checked, the rules checked (packages/domain), the row (and a move's subtree) written, then its change rows and its
// audit. The database checks the tree's structure again at commit (a deferred trigger), and holds the code lock.
import { Injectable } from '@nestjs/common';
import type { Permission } from '@univarse/contracts';
import { calendarDay, type TenantTx } from '@univarse/db';
import {
  archiveProblem,
  capacityProblem,
  childPath,
  codeProblem,
  deactivateProblem,
  effectiveDateProblem,
  lagosToday,
  legacyColumns,
  mayContain,
  moveProblem,
  normaliseCode,
  placementProblem,
  reactivateProblem,
  retypeProblem,
  type OrgProblem,
  type TypeRef,
  type UnitRef,
  type UnitState,
  type UnitTypeKind,
} from '@univarse/domain';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { stale } from '../../shared/http/etag.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { enforceOn } from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { orgUnit, PolicyService, scopeRoots } from '../identity/policy.js';
import { SessionService, type SessionMeta } from '../identity/session.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A unit's row as the use cases read it. */
interface UnitRow {
  id: string;
  parentId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  typeId: string | null;
  path: string;
  state: UnitState;
  codeLockedAt: Date | null;
  version: number;
}

/** A type with its rules, as the use cases and the rules read it. */
interface TypeRow extends TypeRef {
  readonly key: string;
  readonly name: string;
}

type ChangeKind =
  | 'CREATED'
  | 'RENAMED'
  | 'DESCRIBED'
  | 'RETYPED'
  | 'MOVED'
  | 'CODE_CHANGED'
  | 'CODE_CORRECTED'
  | 'DEACTIVATED'
  | 'ARCHIVED'
  | 'REACTIVATED';

export interface UnitListQuery {
  readonly asAt?: string | undefined;
  readonly includeArchived?: 'true' | 'false' | undefined;
  readonly q?: string | undefined;
}

export interface UnitRowView {
  id: string;
  parentId: string | null;
  code: string | null;
  name: string;
  typeId: string | null;
  state: UnitState;
  followsRules: boolean;
}

export interface UnitView {
  id: string;
  parentId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  type: { id: string; key: string; name: string; kind: UnitTypeKind } | null;
  state: UnitState;
  codeLocked: boolean;
  followsRules: boolean;
  version: number;
  ancestors: { id: string; name: string; code: string | null }[];
  children: { open: number; archived: number };
  createdOn: string;
  lastChangedOn: string;
  can: { manage: boolean; restructure: boolean };
}

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const refuse = (p: OrgProblem, status = 422) =>
  new ProblemError(status, p.code, p.message, p.message);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The shared shape of a write's request. */
export interface WriteInput {
  readonly effectiveFrom?: string | undefined;
  readonly reason?: string | undefined;
}

@Injectable()
export class OrgUnitService {
  constructor(
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
    private readonly policy: PolicyService,
  ) {}

  // ─── Reads

  /** Q14: the whole tree in scope, as one list; `asAt` reads it from the history (Q6). */
  async list(
    tenant: TenantContext,
    actor: Actor,
    query: UnitListQuery,
    now = new Date(),
  ): Promise<{ data: UnitRowView[]; asAt: string | null }> {
    const asAt = query.asAt ?? null;
    if (asAt !== null) {
      const p = effectiveDateProblem(asAt, lagosToday(now), null);
      if (p) throw refuse(p);
    }
    const roots = scopeRoots(actor, 'org.unit.view');
    // docs/06 §6: the scope is filtered in the query, never after loading (Q13: a unit is in scope when its current path
    // holds a unit a grant names). The history's rows are scoped by their unit's current path too.
    const all = roots === 'all';
    const patterns = all ? [] : roots.map((r) => `%/${r}/%`);
    const archived = query.includeArchived === 'true';
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (db) => {
      const types = await this.types(db);
      let rows: {
        id: string;
        parentId: string | null;
        code: string | null;
        name: string;
        typeId: string | null;
        state: UnitState;
      }[];
      if (asAt === null) {
        rows = await db.orgUnit.findMany({
          where: {
            ...(all ? {} : { OR: roots.map((r) => ({ path: { contains: `/${r}/` } })) }),
            ...(archived ? {} : { state: { not: 'ARCHIVED' } }),
          },
          select: { id: true, parentId: true, code: true, name: true, typeId: true, state: true },
        });
      } else {
        rows = await db.$queryRaw`
          SELECT * FROM (
            SELECT DISTINCT ON (c.unit_id) c.unit_id::text AS id, c.parent_id::text AS "parentId", c.code, c.name, c.type_id::text AS "typeId", c.state::text AS state
            FROM org_unit_change c JOIN org_unit u ON u.id = c.unit_id
            WHERE c.effective_from <= ${calendarDay(asAt)}::date AND (${all} OR u.path LIKE ANY (${patterns}::text[]))
            ORDER BY c.unit_id, c.effective_from DESC, c.seq DESC
          ) t WHERE ${archived} OR t.state <> 'ARCHIVED'`;
      }
      // Q2: whether each unit still follows its parent's type's rules needs the parent's type, also for a unit whose
      // parent is outside the caller's scope (its type id only, nothing else of it).
      const known = new Set(rows.map((r) => r.id));
      const outside = [
        ...new Set(rows.flatMap((r) => (r.parentId && !known.has(r.parentId) ? [r.parentId] : []))),
      ];
      const parentTypes = new Map(rows.map((r) => [r.id, r.typeId]));
      if (outside.length > 0) {
        for (const p of await db.orgUnit.findMany({
          where: { id: { in: outside } },
          select: { id: true, typeId: true },
        }))
          parentTypes.set(p.id, p.typeId);
      }
      const term = query.q?.toLowerCase();
      const data = rows
        .filter(
          (r) =>
            !term ||
            r.name.toLowerCase().includes(term) ||
            (r.code ?? '').toLowerCase().includes(term),
        )
        .map((r) => {
          const parentTypeId = r.parentId ? (parentTypes.get(r.parentId) ?? null) : null;
          const followsRules =
            r.parentId === null ||
            r.typeId === null ||
            mayContain(parentTypeId ? (types.get(parentTypeId) ?? null) : null, r.typeId);
          return {
            id: r.id,
            parentId: r.parentId,
            code: r.parentId === null ? null : r.code,
            name: r.parentId === null ? tenant.legalName : r.name,
            typeId: r.typeId,
            state: r.state,
            followsRules,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
      return { data, asAt };
    });
  }

  async view(tenant: TenantContext, actor: Actor, id: string): Promise<UnitView> {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (db) => {
      const unit = await this.find(db, id);
      enforceOn(actor, 'org.unit.view', orgUnit(unit));
      return this.toView(db, tenant, actor, unit);
    });
  }

  async history(tenant: TenantContext, actor: Actor, id: string) {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (db) => {
      const unit = await this.find(db, id);
      enforceOn(actor, 'org.unit.view', orgUnit(unit));
      const changes = await db.orgUnitChange.findMany({
        where: { unitId: unit.id },
        orderBy: [{ effectiveFrom: 'desc' }, { seq: 'desc' }],
      });
      const actorIds = [...new Set(changes.flatMap((c) => (c.actorId ? [c.actorId] : [])))];
      const people = new Map(
        (
          await db.userAccount.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, displayName: true },
          })
        ).map((u) => [u.id, u]),
      );
      return {
        data: changes.map((c) => ({
          id: c.id,
          kind: c.kind,
          effectiveFrom: day(c.effectiveFrom),
          recordedAt: c.createdAt.toISOString(),
          code: c.parentId === null ? null : c.code,
          name: c.parentId === null ? tenant.legalName : c.name,
          typeId: c.typeId,
          parentId: c.parentId,
          state: c.state,
          reason: c.reason,
          actor: c.actorId ? (people.get(c.actorId) ?? null) : null,
        })),
      };
    });
  }

  // ─── Writes

  /** Q3, Q8, Q-A2: a new unit under `parentId`. A replay of the same key by the same person answers with its unit. */
  async create(
    tenant: TenantContext,
    actor: Actor,
    body: {
      parentId: string;
      typeId: string;
      name: string;
      code?: string | null | undefined;
      description?: string | null | undefined;
      effectiveFrom?: string | undefined;
    },
    creationKey: string,
    meta: SessionMeta,
    now = new Date(),
  ): Promise<{ view: UnitView; replayed: boolean }> {
    const replayed = await this.shards.tx(tenant.shardId, tenant.tenantId, async (db) => {
      const unit = await this.replay(db, actor, creationKey);
      return unit ? this.toView(db, tenant, actor, unit) : null;
    });
    if (replayed) return { view: replayed, replayed: true };
    const id = await this.write(
      tenant,
      async (tx) => {
        const parent = await this.lock(tx, body.parentId, 'org.unit.parent_not_found');
        enforceOn(actor, 'org.unit.manage', orgUnit(parent), 'org.unit.parent_not_found');
        const types = await this.types(tx);
        const childType = types.get(body.typeId);
        if (!childType)
          throw new ProblemError(404, 'org.unit.type_not_found', 'Unit type not found');
        const p =
          capacityProblem(await tx.orgUnit.count()) ??
          placementProblem({
            parent: ref(parent),
            parentType: parent.typeId ? (types.get(parent.typeId) ?? null) : null,
            childType,
          });
        if (p) throw refuse(p);
        const code = this.code(body.code);
        const effective = await this.effectiveDate(
          tx,
          body.effectiveFrom,
          now,
          null,
          parent.parentId === null ? null : parent.id,
        );
        const created = await tx.orgUnit.create({
          data: {
            tenantId: tenant.tenantId,
            code,
            name: body.name,
            description: body.description || null,
            typeId: childType.id,
            parentId: parent.id,
            path: parent.path, // completed below, once the id exists; the tree's check runs at commit
            state: 'ACTIVE',
            creationKey,
            ...legacyColumns(childType.kind, childType.key, 'ACTIVE'),
          },
          select: { id: true },
        });
        const row = await this.reload(tx, created.id, { path: childPath(parent.path, created.id) });
        if (code) await this.reserve(tx, tenant.tenantId, code, row.id);
        await this.record(tx, tenant.tenantId, row, ['CREATED'], effective, actor.userId, null);
        await this.auditWrite(
          tx,
          tenant,
          actor,
          meta,
          'org.unit.created',
          row,
          null,
          describe(row),
          ['CREATED'],
          effective,
          null,
        );
        return row.id;
      },
      creationKey,
    );
    if (id === null) {
      // Another request with the same key won the race: answer with its unit, or refuse.
      const again = await this.shards.tx(tenant.shardId, tenant.tenantId, async (db) => {
        const unit = await this.replay(db, actor, creationKey);
        return unit ? this.toView(db, tenant, actor, unit) : null;
      });
      if (!again) throw new ProblemError(409, 'org.unit.key_reused', 'Idempotency key reused');
      return { view: again, replayed: true };
    }
    return { view: await this.view(tenant, actor, id), replayed: false };
  }

  /** Name, description, an unlocked code (a correction, Q9) and the type (Q10, restructure), as one PATCH (Q-A6). */
  async update(
    tenant: TenantContext,
    actor: Actor,
    id: string,
    expected: number,
    body: {
      name?: string | undefined;
      description?: string | null | undefined;
      code?: string | null | undefined;
      typeId?: string | undefined;
    } & WriteInput,
    meta: SessionMeta,
    now = new Date(),
  ): Promise<UnitView> {
    await this.write(tenant, async (tx) => {
      const unit = await this.lock(tx, id);
      enforceOn(actor, 'org.unit.manage', orgUnit(unit));
      if (body.typeId !== undefined) enforceOn(actor, 'org.unit.restructure', orgUnit(unit));
      if (unit.version !== expected) throw stale();
      if (unit.parentId === null)
        throw refuse({
          code: 'org.unit.root_fixed',
          message: 'The institution itself is changed in its profile, not here.',
        });
      const types = await this.types(tx);
      const kinds: ChangeKind[] = [];
      const data: Partial<UnitRow> = {};
      if (body.name !== undefined && body.name !== unit.name) {
        kinds.push('RENAMED');
        data.name = body.name;
      }
      if (body.description !== undefined && (body.description || null) !== unit.description) {
        kinds.push('DESCRIBED');
        data.description = body.description || null;
      }
      let code: { from: string | null; to: string | null } | null = null;
      if (body.code !== undefined) {
        const next = this.code(body.code);
        if (next !== unit.code) {
          if (unit.codeLockedAt)
            throw new ProblemError(
              409,
              'org.unit.code_locked',
              'Code locked',
              'This code is on issued identifiers. Give the unit a new code instead.',
            );
          kinds.push('CODE_CORRECTED');
          data.code = next;
          code = { from: unit.code, to: next };
        }
      }
      let newType: TypeRow | undefined;
      if (body.typeId !== undefined && body.typeId !== unit.typeId) {
        newType = types.get(body.typeId);
        if (!newType) throw new ProblemError(404, 'org.unit.type_not_found', 'Unit type not found');
        const parent = await this.reload(tx, unit.parentId);
        const children = await tx.orgUnit.findMany({
          where: { parentId: unit.id },
          select: { typeId: true },
        });
        const p = retypeProblem({
          unit: ref(unit),
          currentType: unit.typeId ? (types.get(unit.typeId) ?? null) : null,
          newType,
          parentType: parent.typeId ? (types.get(parent.typeId) ?? null) : null,
          childTypeIds: children.flatMap((c) => (c.typeId ? [c.typeId] : [])),
        });
        if (p) throw refuse(p);
        kinds.push('RETYPED');
        data.typeId = newType.id;
      }
      if (kinds.length === 0) return unit.id;
      const effective = await this.effectiveDate(tx, body.effectiveFrom, now, unit.id);
      const type = newType ?? (unit.typeId ? types.get(unit.typeId) : undefined);
      const row = await this.reload(tx, unit.id, {
        ...data,
        version: unit.version + 1,
        ...legacyColumns(type?.kind ?? null, type?.key ?? null, unit.state),
      });
      if (code) {
        if (code.to) await this.reserve(tx, tenant.tenantId, code.to, row.id);
        if (code.from)
          await tx.orgUnitCode.deleteMany({ where: { unitId: row.id, code: code.from } }); // released (Q9)
      }
      await this.record(
        tx,
        tenant.tenantId,
        row,
        kinds,
        effective,
        actor.userId,
        body.reason ?? null,
      );
      await this.auditWrite(
        tx,
        tenant,
        actor,
        meta,
        'org.unit.updated',
        row,
        describe(unit),
        describe(row),
        kinds,
        effective,
        body.reason ?? null,
      );
      return row.id;
    });
    return this.view(tenant, actor, id);
  }

  /** Q11: the unit and its whole subtree under a new parent; restructure on both ends (Q13). */
  async move(
    tenant: TenantContext,
    actor: Actor,
    id: string,
    expected: number,
    body: { parentId: string } & WriteInput,
    meta: SessionMeta,
    now = new Date(),
  ): Promise<UnitView> {
    await this.write(tenant, async (tx) => {
      // Both rows locked in id order, so two crossing moves wait for each other instead of deadlocking; the second
      // then reads the first's paths and finds its cycle.
      await tx.$queryRaw`SELECT id FROM org_unit WHERE id IN (${uuidOr404(id)}::uuid, ${uuidOr404(body.parentId, 'org.unit.parent_not_found')}::uuid) ORDER BY id FOR UPDATE`;
      const unit = await this.lock(tx, id);
      enforceOn(actor, 'org.unit.restructure', orgUnit(unit));
      const parent = await this.lock(tx, body.parentId, 'org.unit.parent_not_found');
      enforceOn(actor, 'org.unit.restructure', orgUnit(parent), 'org.unit.parent_not_found');
      if (unit.version !== expected) throw stale();
      const types = await this.types(tx);
      const height = await this.subtreeHeight(tx, unit);
      const p = moveProblem({
        unit: ref(unit),
        unitType: unit.typeId ? (types.get(unit.typeId) ?? null) : null,
        newParent: ref(parent),
        newParentType: parent.typeId ? (types.get(parent.typeId) ?? null) : null,
        subtreeHeight: height,
      });
      if (p) throw refuse(p);
      const effective = await this.effectiveDate(
        tx,
        body.effectiveFrom,
        now,
        unit.id,
        parent.parentId === null ? null : parent.id,
      );
      const next = childPath(parent.path, unit.id);
      await tx.$executeRaw`
        UPDATE org_unit SET path = ${next} || substr(path, ${unit.path.length + 1}), updated_at = CURRENT_TIMESTAMP
        WHERE starts_with(path, ${unit.path})`;
      const row = await this.reload(tx, unit.id, {
        parentId: parent.id,
        version: unit.version + 1,
      });
      await this.record(
        tx,
        tenant.tenantId,
        row,
        ['MOVED'],
        effective,
        actor.userId,
        body.reason ?? null,
      );
      await this.auditWrite(
        tx,
        tenant,
        actor,
        meta,
        'org.unit.moved',
        row,
        { parentId: unit.parentId },
        { parentId: parent.id },
        ['MOVED'],
        effective,
        body.reason ?? null,
        { units: await tx.orgUnit.count({ where: { path: { startsWith: next } } }) },
      );
      return row.id;
    });
    return this.view(tenant, actor, id);
  }

  /** Q5: deactivate (manage), archive (restructure, leaf first) or reactivate (manage; restructure from archived). */
  async setState(
    tenant: TenantContext,
    actor: Actor,
    id: string,
    expected: number,
    to: 'deactivate' | 'archive' | 'reactivate',
    body: WriteInput,
    meta: SessionMeta,
    now = new Date(),
  ): Promise<UnitView> {
    await this.write(tenant, async (tx) => {
      const unit = await this.lock(tx, id);
      const permission: Permission =
        to === 'archive' || (to === 'reactivate' && unit.state === 'ARCHIVED')
          ? 'org.unit.restructure'
          : 'org.unit.manage';
      enforceOn(actor, permission, orgUnit(unit));
      if (unit.version !== expected) throw stale();
      let p: OrgProblem | null;
      let state: UnitState;
      let kind: ChangeKind;
      if (to === 'deactivate') {
        p = deactivateProblem(ref(unit));
        [state, kind] = ['INACTIVE', 'DEACTIVATED'];
      } else if (to === 'archive') {
        p = archiveProblem(
          ref(unit),
          await tx.orgUnit.count({ where: { parentId: unit.id, state: { not: 'ARCHIVED' } } }),
        );
        [state, kind] = ['ARCHIVED', 'ARCHIVED'];
      } else {
        p = reactivateProblem(
          ref(unit),
          unit.parentId ? ref(await this.reload(tx, unit.parentId)) : null,
        );
        [state, kind] = ['ACTIVE', 'REACTIVATED'];
      }
      if (p) throw refuse(p);
      const effective = await this.effectiveDate(tx, body.effectiveFrom, now, unit.id);
      const types = await this.types(tx);
      const type = unit.typeId ? types.get(unit.typeId) : undefined;
      const row = await this.reload(tx, unit.id, {
        state,
        version: unit.version + 1,
        ...legacyColumns(type?.kind ?? null, type?.key ?? null, state),
      });
      await this.record(
        tx,
        tenant.tenantId,
        row,
        [kind],
        effective,
        actor.userId,
        body.reason ?? null,
      );
      const action =
        to === 'deactivate'
          ? 'org.unit.deactivated'
          : to === 'archive'
            ? 'org.unit.archived'
            : 'org.unit.reactivated';
      await this.auditWrite(
        tx,
        tenant,
        actor,
        meta,
        action,
        row,
        { state: unit.state },
        { state },
        [kind],
        effective,
        body.reason ?? null,
      );
      return row.id;
    });
    return this.view(tenant, actor, id);
  }

  /** Q9: a locked unit's new code, dated, with a reason; its old code stays reserved for ever. */
  async changeCode(
    tenant: TenantContext,
    actor: Actor,
    id: string,
    expected: number,
    body: { code: string } & WriteInput,
    meta: SessionMeta,
    now = new Date(),
  ): Promise<UnitView> {
    await this.write(tenant, async (tx) => {
      const unit = await this.lock(tx, id);
      enforceOn(actor, 'org.unit.restructure', orgUnit(unit));
      if (unit.version !== expected) throw stale();
      if (unit.parentId === null)
        throw refuse({
          code: 'org.unit.root_fixed',
          message: 'The institution’s own code is never changed.',
        });
      if (!unit.codeLockedAt)
        throw new ProblemError(
          409,
          'org.unit.code_not_locked',
          'Code not locked',
          'This code isn’t locked yet. Edit the unit to correct it.',
        );
      const code = this.code(body.code);
      if (code === null)
        throw refuse({ code: 'org.unit.code_invalid', message: 'A locked unit keeps a code.' });
      if (code === unit.code)
        throw refuse({ code: 'org.unit.same_code', message: 'The unit already has that code.' });
      const effective = await this.effectiveDate(tx, body.effectiveFrom, now, unit.id);
      const row = await this.reload(tx, unit.id, { code, version: unit.version + 1 });
      await this.reserve(tx, tenant.tenantId, code, row.id);
      await this.record(
        tx,
        tenant.tenantId,
        row,
        ['CODE_CHANGED'],
        effective,
        actor.userId,
        body.reason ?? null,
      );
      await this.auditWrite(
        tx,
        tenant,
        actor,
        meta,
        'org.unit.code_changed',
        row,
        { acronym: unit.code },
        { acronym: code },
        ['CODE_CHANGED'],
        effective,
        body.reason ?? null,
      );
      return row.id;
    });
    return this.view(tenant, actor, id);
  }

  // ─── Helpers

  /** Runs `fn` in the tenant's transaction; a create's duplicate key (its race) comes back as null. */
  private async write(
    tenant: TenantContext,
    fn: (tx: TenantTx) => Promise<string>,
    creationKey?: string,
  ): Promise<string | null> {
    try {
      return await this.shards.tx(tenant.shardId, tenant.tenantId, fn);
    } catch (err) {
      const target = uniqueTarget(err);
      if (target === null) throw err;
      if (creationKey && target.includes('creation_key')) return null;
      if (target.includes('code'))
        throw new ProblemError(
          409,
          'org.unit.code_taken',
          'Code taken',
          'That code is already used, or was used, by another unit.',
        );
      throw err;
    }
  }

  private async replay(db: TenantTx, actor: Actor, creationKey: string): Promise<UnitRow | null> {
    const unit = await db.orgUnit.findUnique({
      where: { tenantId_creationKey: { tenantId: actor.tenantId, creationKey } },
      select: UNIT_SELECT,
    });
    if (!unit) return null;
    const created = await db.orgUnitChange.findFirst({
      where: { unitId: unit.id, kind: 'CREATED' },
      select: { actorId: true },
    });
    if (created?.actorId !== actor.userId)
      throw new ProblemError(409, 'org.unit.key_reused', 'Idempotency key reused');
    // Q13 (the security review of PR A): a replay answers only while the unit is still in the caller's view; one moved
    // out of their scope since is 404, as any unit outside it.
    enforceOn(actor, 'org.unit.view', orgUnit(unit));
    return unit;
  }

  private async find(db: TenantTx, id: string): Promise<UnitRow> {
    if (!UUID.test(id)) throw notFound();
    const unit = await db.orgUnit.findUnique({ where: { id }, select: UNIT_SELECT });
    if (!unit) throw notFound();
    return unit;
  }

  /** The row, locked for this transaction. Unknown or malformed: 404 with `missing`. */
  private async lock(tx: TenantTx, id: string, missing = 'resource.not_found'): Promise<UnitRow> {
    const notThere = () => new ProblemError(404, missing, 'Not found');
    if (!UUID.test(id)) throw notThere();
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM org_unit WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notThere();
    return this.reload(tx, id);
  }

  /** Reads the row again, after writing `data` to it if given. */
  private async reload(tx: TenantTx, id: string, data?: Record<string, unknown>): Promise<UnitRow> {
    if (data) return tx.orgUnit.update({ where: { id }, data, select: UNIT_SELECT });
    return tx.orgUnit.findUniqueOrThrow({ where: { id }, select: UNIT_SELECT });
  }

  private async types(db: TenantTx): Promise<Map<string, TypeRow>> {
    const rows = await db.unitType.findMany({
      select: {
        id: true,
        key: true,
        name: true,
        kind: true,
        status: true,
        contains: { select: { childTypeId: true } },
      },
    });
    return new Map(
      rows.map((t) => [
        t.id,
        {
          id: t.id,
          key: t.key,
          name: t.name,
          kind: t.kind,
          status: t.status,
          mayContain: t.contains.map((c) => c.childTypeId),
        },
      ]),
    );
  }

  /** Q8: as typed, normalised; refused if it isn't a code. */
  private code(raw: string | null | undefined): string | null {
    const code = normaliseCode(raw);
    if (code === null) return null;
    const p = codeProblem(code);
    if (p) throw refuse(p);
    return code;
  }

  /** Q8: the code is free, or the unit already holds it; never another unit's, current or former. */
  private async reserve(
    tx: TenantTx,
    tenantId: string,
    code: string,
    unitId: string,
  ): Promise<void> {
    const held = await tx.orgUnitCode.findUnique({
      where: { tenantId_code: { tenantId, code } },
      select: { unitId: true },
    });
    if (held && held.unitId !== unitId)
      throw new ProblemError(
        409,
        'org.unit.code_taken',
        'Code taken',
        'That code is already used, or was used, by another unit.',
      );
    if (!held) await tx.orgUnitCode.create({ data: { tenantId, code, unitId } });
  }

  /**
   * Q7: the change's date, today in Lagos by default. Never before the unit's last change (`unitId`), nor before a
   * parent's creation (`parentId`). Q-A7: the root's creation bounds nothing, since the institution predates its account.
   */
  private async effectiveDate(
    tx: TenantTx,
    given: string | undefined,
    now: Date,
    unitId: string | null,
    parentId: string | null = null,
  ): Promise<string> {
    const date = given ?? lagosToday(now);
    const bounds: string[] = [];
    if (unitId) {
      const last = await tx.orgUnitChange.findFirst({
        where: { unitId },
        orderBy: [{ effectiveFrom: 'desc' }, { seq: 'desc' }],
        select: { effectiveFrom: true },
      });
      if (last) bounds.push(day(last.effectiveFrom));
    }
    if (parentId) {
      const created = await tx.orgUnitChange.findFirst({
        where: { unitId: parentId, kind: 'CREATED' },
        select: { effectiveFrom: true },
      });
      if (created) bounds.push(day(created.effectiveFrom));
    }
    const notBefore = bounds.sort().at(-1) ?? null;
    const p = effectiveDateProblem(date, lagosToday(now), notBefore);
    if (p) throw refuse(p);
    return date;
  }

  private async subtreeHeight(tx: TenantTx, unit: UnitRow): Promise<number> {
    const rows = await tx.$queryRaw<{ h: number | null }[]>`
      SELECT max(array_length(string_to_array(trim(both '/' from substr(path, ${unit.path.length})), '/'), 1))::int AS h
      FROM org_unit WHERE starts_with(path, ${unit.path}) AND id <> ${unit.id}::uuid`;
    return rows[0]?.h ?? 0;
  }

  /** Q6, Q-A6: one change row per kind, each with the unit's state after it. */
  private async record(
    tx: TenantTx,
    tenantId: string,
    row: UnitRow,
    kinds: readonly ChangeKind[],
    effective: string,
    actorId: string,
    reason: string | null,
  ): Promise<void> {
    for (const kind of kinds) {
      await tx.orgUnitChange.create({
        data: {
          tenantId,
          unitId: row.id,
          kind,
          code: row.code,
          name: row.name,
          description: row.description,
          typeId: row.typeId,
          parentId: row.parentId,
          state: row.state,
          effectiveFrom: calendarDay(effective),
          actorId,
          reason,
        },
      });
    }
  }

  private async auditWrite(
    tx: TenantTx,
    tenant: TenantContext,
    actor: Actor,
    meta: SessionMeta,
    action: string,
    row: UnitRow,
    before: unknown,
    after: unknown,
    kinds: readonly ChangeKind[],
    effectiveFrom: string,
    reason: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.write(tx, tenant.tenantId, {
      actorType: 'USER',
      actorId: actor.userId,
      action,
      entityType: 'org_unit',
      entityId: row.id,
      before,
      after: { ...(after as object | null), kinds, effectiveFrom, ...extra },
      reason,
      ...SessionService.auditMeta(meta),
    });
  }

  private async toView(
    db: TenantTx,
    tenant: TenantContext,
    actor: Actor,
    unit: UnitRow,
  ): Promise<UnitView> {
    const types = await this.types(db);
    const ancestorIds = unit.path.split('/').filter((s) => s && s !== unit.id);
    const ancestors = await db.orgUnit.findMany({
      where: { id: { in: ancestorIds } },
      select: { id: true, parentId: true, name: true, code: true, typeId: true },
    });
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    const [open, archived, first, last] = await Promise.all([
      db.orgUnit.count({ where: { parentId: unit.id, state: { not: 'ARCHIVED' } } }),
      db.orgUnit.count({ where: { parentId: unit.id, state: 'ARCHIVED' } }),
      db.orgUnitChange.findFirst({
        where: { unitId: unit.id },
        orderBy: [{ effectiveFrom: 'asc' }, { seq: 'asc' }],
        select: { effectiveFrom: true },
      }),
      db.orgUnitChange.findFirst({
        where: { unitId: unit.id },
        orderBy: [{ effectiveFrom: 'desc' }, { seq: 'desc' }],
        select: { effectiveFrom: true },
      }),
    ]);
    const type = unit.typeId ? types.get(unit.typeId) : undefined;
    const parentTypeId = unit.parentId ? (byId.get(unit.parentId)?.typeId ?? null) : null;
    const ctx = orgUnit(unit);
    const isRoot = unit.parentId === null;
    return {
      id: unit.id,
      parentId: unit.parentId,
      code: isRoot ? null : unit.code,
      name: isRoot ? tenant.legalName : unit.name,
      description: unit.description,
      type: type ? { id: type.id, key: type.key, name: type.name, kind: type.kind } : null,
      state: unit.state,
      codeLocked: unit.codeLockedAt !== null,
      followsRules:
        isRoot ||
        unit.typeId === null ||
        mayContain(parentTypeId ? (types.get(parentTypeId) ?? null) : null, unit.typeId),
      version: unit.version,
      ancestors: ancestorIds.flatMap((aid) => {
        const a = byId.get(aid);
        return a
          ? [
              {
                id: a.id,
                name: a.parentId === null ? tenant.legalName : a.name,
                code: a.parentId === null ? null : a.code,
              },
            ]
          : [];
      }),
      children: { open, archived },
      createdOn: first ? day(first.effectiveFrom) : day(new Date()),
      lastChangedOn: last ? day(last.effectiveFrom) : day(new Date()),
      can: {
        manage: this.policy.holds(actor, 'org.unit.manage', ctx),
        restructure: this.policy.holds(actor, 'org.unit.restructure', ctx),
      },
    };
  }
}

const UNIT_SELECT = {
  id: true,
  parentId: true,
  code: true,
  name: true,
  description: true,
  typeId: true,
  path: true,
  state: true,
  codeLockedAt: true,
  version: true,
} as const;

const ref = (u: UnitRow): UnitRef => ({
  id: u.id,
  parentId: u.parentId,
  path: u.path,
  state: u.state,
  typeId: u.typeId,
});

/** What an audit records of a unit: never its code under a key naming a code (the redaction blanks those). */
const describe = (u: UnitRow) => ({
  name: u.name,
  acronym: u.code,
  description: u.description,
  typeId: u.typeId,
  parentId: u.parentId,
  state: u.state,
});

function uuidOr404(id: string, code = 'resource.not_found'): string {
  if (!UUID.test(id)) throw new ProblemError(404, code, 'Not found');
  return id;
}

/** A unique violation's target (its columns or constraint), or null if the error isn't one. */
function uniqueTarget(err: unknown): string | null {
  const e = err as {
    code?: unknown;
    meta?: {
      target?: unknown;
      constraint?: unknown;
      driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } };
    };
    message?: unknown;
  };
  if (e.code !== 'P2002') return null;
  return JSON.stringify([
    e.meta?.target,
    e.meta?.constraint,
    e.meta?.driverAdapterError?.cause?.constraint?.fields,
    e.message,
  ]);
}
