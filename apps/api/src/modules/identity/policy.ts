// Spec 0018 (ADR-028, docs/08 §4): the one place a permission is decided. `evaluate()` is the whole rule, pure
// and matrix-tested; `PolicyService` is its injectable face. Nothing else reads an actor's grants to decide access
// (a static guard, policy-guard.spec.ts, holds that).
import { Injectable } from '@nestjs/common';
import type { Permission } from '@univarse/contracts';
import { hasFreshStepUp, isPrivileged, requiresStepUp, type Actor, type Grant } from './actor.js';

/**
 * What a permission is checked against. One variant today; each resource scope (ORG_UNIT, PROGRAMME, COHORT,
 * COURSE_OFFERING, HOSTEL) adds its own, with its containment check, alongside its first consuming module (ADR-028).
 * Until then a check against such a scope doesn't type-check (D2).
 */
export type ResourceContext = { readonly scope: 'INSTITUTION' };
export const INSTITUTION: ResourceContext = Object.freeze({ scope: 'INSTITUTION' });

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

/** Whether a grant covers the context. One context today (D2); each resource scope adds its branch here. */
const covers = (g: Grant, _resource: ResourceContext): boolean => coversInstitution(g);

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
