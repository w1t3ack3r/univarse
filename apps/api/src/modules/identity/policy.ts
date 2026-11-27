// Spec 0018 (ADR-028, docs/08 §4): the one place a permission is decided. `evaluate()` is the whole rule, pure
// and matrix-tested; `PolicyService` is its injectable face. Nothing else reads an actor's grants to decide access
// (a static guard, policy-guard.spec.ts, holds that).
import { Injectable } from '@nestjs/common';
import type { Permission } from '@univarse/contracts';
import { hasFreshStepUp, isPrivileged, requiresStepUp, type Actor, type Grant } from './actor.js';

/**
 * What a permission is checked against. Each resource scope adds its variant, with its containment check, alongside
 * its first consuming module (ADR-028): `ORG_UNIT` with the org tree (spec 0042 Q13), built from the LOADED unit.
 * PROGRAMME, COHORT, COURSE_OFFERING and HOSTEL don't type-check until theirs (D2).
 */
export type ResourceContext =
  | { readonly scope: 'INSTITUTION' }
  | { readonly scope: 'ORG_UNIT'; readonly unitId: string; readonly path: string };
export const INSTITUTION: ResourceContext = Object.freeze({ scope: 'INSTITUTION' });

/** Spec 0042 Q13: the context of a unit, from the row the use case loaded (never from request input). */
export const orgUnit = (unit: { readonly id: string; readonly path: string }): ResourceContext => Object.freeze({ scope: 'ORG_UNIT', unitId: unit.id, path: unit.path });

export type Refusal = 'forbidden' | 'mfa_required' | 'step_up_required';
export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: Refusal };

/** All the policy may see of the actor. */
export type PolicyActor = Pick<Actor, 'grants' | 'mfaAt' | 'stepUpAt'>;

/**
 * D4: a grant counts for the institution only when its scope is INSTITUTION *and* it names no resource. A
 * malformed grant, or one whose scope the policy doesn't know, counts for nothing.
 */
const coversInstitution = (g: Grant): boolean =>
  g.scopeType === 'INSTITUTION' && g.scopeId === null;

/**
 * Spec 0042 Q13: a grant scoped to a unit covers that unit and every unit under it, read from the loaded unit's
 * path (which holds every ancestor's id). A grant scoped to a unit that isn't on the path covers nothing.
 */
const coversUnit = (g: Grant, path: string): boolean =>
  g.scopeType === 'ORG_UNIT' && typeof g.scopeId === 'string' && g.scopeId.length > 0 && path.includes(`/${g.scopeId}/`);

/** Whether a grant covers the context: an institution grant covers everything; each resource scope adds its branch. */
const covers = (g: Grant, resource: ResourceContext): boolean =>
  coversInstitution(g) || (resource.scope === 'ORG_UNIT' && coversUnit(g, resource.path));

/** Grants the policy understands at some scope (a malformed or unknown one counts for nothing, D4). */
const knownScope = (g: Grant): boolean => coversInstitution(g) || (g.scopeType === 'ORG_UNIT' && typeof g.scopeId === 'string' && g.scopeId.length > 0);

/**
 * Spec 0042: whether the permission is held at any scope the policy knows. A scoped route's first gate: an actor
 * with no such grant anywhere is refused (403) before anything is loaded; each unit is then decided on its own.
 */
export function holdsSomewhere(actor: PolicyActor, permission: Permission): boolean {
  return actor.grants.some((g) => g.permission === permission && knownScope(g));
}

/**
 * Spec 0042 Q13, for a list: the unit ids the actor's grants of `permission` are scoped to, or `'all'` when one
 * covers the institution. A unit is in scope when its path holds one of them.
 */
export function scopeRoots(actor: PolicyActor, permission: Permission): 'all' | readonly string[] {
  const held = actor.grants.filter((g) => g.permission === permission);
  if (held.some(coversInstitution)) return 'all';
  return [...new Set(held.filter(knownScope).map((g) => g.scopeId as string))];
}

const ALLOW: Decision = Object.freeze({ allowed: true });
const refuse = (reason: Refusal): Decision => ({ allowed: false, reason });

/**
 * Whether the permission is held in the context: the scope rule alone, without MFA or step-up. For showing what a
 * caller may do (a setting's `canManage`); the action itself is still decided by `evaluate()`.
 */
export function holds(
  actor: PolicyActor,
  permission: Permission,
  resource: ResourceContext,
): boolean {
  return actor.grants.some((g) => g.permission === permission && covers(g, resource));
}

/**
 * D3: held in the context, then MFA if the permission is privileged, then a fresh step-up if the catalog flags it;
 * the first that fails is the reason (the order AccessGuard has always applied).
 */
export function evaluate(
  actor: PolicyActor,
  permission: Permission,
  resource: ResourceContext,
  now: Date,
): Decision {
  if (!holds(actor, permission, resource)) return refuse('forbidden');
  if (isPrivileged(permission) && !actor.mfaAt) return refuse('mfa_required');
  if (requiresStepUp(permission) && !hasFreshStepUp(actor, now)) return refuse('step_up_required');
  return ALLOW;
}

/** The permissions held in the context, sorted and distinct (for /auth/me). */
export function permissionsHeld(actor: PolicyActor, resource: ResourceContext): Permission[] {
  return [
    ...new Set(actor.grants.filter((g) => covers(g, resource)).map((g) => g.permission)),
  ].sort();
}

@Injectable()
export class PolicyService {
  decide(
    actor: PolicyActor,
    permission: Permission,
    resource: ResourceContext,
    now: Date = new Date(),
  ): Decision {
    return evaluate(actor, permission, resource, now);
  }

  can(
    actor: PolicyActor,
    permission: Permission,
    resource: ResourceContext,
    now: Date = new Date(),
  ): boolean {
    return evaluate(actor, permission, resource, now).allowed;
  }

  /** Held in the context, ignoring MFA and step-up: for display only (see `holds`). */
  holds(actor: PolicyActor, permission: Permission, resource: ResourceContext): boolean {
    return holds(actor, permission, resource);
  }

  held(actor: PolicyActor, resource: ResourceContext): Permission[] {
    return permissionsHeld(actor, resource);
  }
}
