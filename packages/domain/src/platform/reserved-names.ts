/**
 * Spec 0027 P2: names no tenant can take, because UniVarse's own hosts use them under the same domain as the tenants'
 * subdomains (`console.univarse.ng`, `api.univarse.ng`, `files.…`, `mail.…`). A tenant holding one could be served on
 * the console's own host. The tenant resolver never resolves one, and provisioning (S5) refuses one at creation.
 */
export const RESERVED_NAMES: readonly string[] = Object.freeze([
  'admin',
  'api',
  'auth',
  'console',
  'files',
  'mail',
  'platform',
  'static',
  'status',
  'www',
]);

/** Whether a tenant slug (a subdomain's first label) is reserved. Case and surrounding space don't matter. */
export function isReservedName(slug: string): boolean {
  return RESERVED_NAMES.includes(slug.trim().toLowerCase());
}

/** Whether a host's first label is reserved: `console.univarse.ng` is, `unilag.univarse.ng` isn't. */
export function hasReservedFirstLabel(host: string): boolean {
  const first = host.trim().toLowerCase().split('.')[0] ?? '';
  return isReservedName(first);
}
