// Spec 0019: the typed face of spec 0013's release tooling (JavaScript), for the deploy. Verification, roles and
// Dockerfiles are always those trusted tools' own; nothing here re-implements them.
import { HOST_REGISTRY, olderRoleSet, ROLES, rolesOf, TOOL_REGISTRY } from '../../images/release-lib.mjs';
import { acquireRegistryLock as acquire } from '../../images/registry-lock.mjs';
import { verifyRelease as verify } from '../../images/verify-release.mjs';

export interface ReleaseRecord {
  readonly commit: string;
  readonly rehearsal?: boolean;
  readonly images: Readonly<Record<string, { repo: string; digest: string }>>;
}
export interface Verification {
  readonly ok: boolean;
  readonly problems: string[];
  /** role → `registry:5000/<repo>@sha256:…`, for every role that verified. */
  readonly results: Readonly<Record<string, string>>;
}

/**
 * The deploy's check: every role in ROLES, the commit from the deployment target, never a rehearsal (LR9). `roles`
 * verifies an older release as it was signed instead (the restore's, spec 0027 P7); the deploy never passes it.
 */
export const verifyRelease = (record: ReleaseRecord, opts: { commit: string; roles?: readonly string[] }): Verification =>
  // The JavaScript's option types are inferred from its defaults, which don't name `commit` or `roles`.
  (verify as unknown as (r: ReleaseRecord, o: { commit: string; roles?: unknown }) => Verification)(record, {
    commit: opts.commit,
    ...(opts.roles ? { roles: (rolesOf as (n: readonly string[]) => unknown)(opts.roles) } : {}),
  });

export const acquireRegistryLock = (dir: string, holder: string): { release(): void } => acquire(dir, holder);

export const RELEASE_ROLES: readonly string[] = Object.keys(ROLES);

/**
 * The role set a record was released with: an older set it names exactly (spec 0019's four roles, or api and web),
 * otherwise every role. A record naming anything else then fails verification on its own terms.
 */
export function roleSetOf(record: ReleaseRecord): readonly string[] {
  return (olderRoleSet as (n: readonly string[]) => readonly string[] | undefined)(Object.keys(record.images)) ?? RELEASE_ROLES;
}

/** A verified tool-network reference as the host's Docker pulls it (the same registry, its host address). */
export function hostRef(toolRef: string): string {
  const prefix = `${TOOL_REGISTRY as string}/`;
  if (!toolRef.startsWith(prefix)) throw new Error(`not a reference into the local registry: ${toolRef}`);
  return `${HOST_REGISTRY as string}/${toolRef.slice(prefix.length)}`;
}
