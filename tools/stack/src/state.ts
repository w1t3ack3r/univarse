// Spec 0019: the deploy's state file, kept apart from deploy.ts so the deploy's steps can use it without an import cycle.
/**
 * The deploy's state (releases/deploy-state.json): the digests running now and the previous ones, which
 * `pnpm images:prune` always keeps (spec 0013 LR8's deployPins).
 */
export function nextState(prev: unknown, images: Readonly<Record<string, string>>): { current: { repo: string; digest: string }[]; rollback: { repo: string; digest: string }[][] } {
  const pins = Object.values(images).map((ref) => {
    const [repoWithHost = '', digest = ''] = ref.split('@');
    return { repo: repoWithHost.slice(repoWithHost.indexOf('/') + 1), digest };
  });
  const p = (prev ?? {}) as { current?: { repo: string; digest: string }[]; rollback?: { repo: string; digest: string }[][] };
  const rollback = [...(p.current ? [p.current] : []), ...(p.rollback ?? [])].slice(0, 2);
  return { current: pins, rollback };
}
