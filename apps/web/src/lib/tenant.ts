import type { ResponseBody } from '@univarse/api-client';
export { logoUrl } from '@univarse/api-client';
import { serverGet } from './server-api';

import type { CSSProperties } from 'react';

/**
 * Spec 0033 Q10, Q11: an institution's colour, as CSS variables. The text colour is the one the domain chose for this
 * colour (at least 4.5:1), so the pair never reads badly, whatever an institution picks.
 */
export const brandStyle = (primary: string, text: string): CSSProperties => ({ '--uv-brand': primary, '--uv-on-brand': text } as CSSProperties);

export type TenantProfile = ResponseBody<'/api/v1/tenant/public-profile', 'get'>;

/**
 * Spec 0037 Q8, 0038 Q5, 0039 Q10: an institution that can't be served, with its public name and colours, as its 423,
 * 410 or 503 carries them. `kind` says which: a suspension is temporary, an archived account has closed, and a shard in
 * maintenance comes back once its migration succeeds.
 */
export type UnavailableKind = 'suspended' | 'closed' | 'maintenance';
export type SuspendedInstitution = { legalName: string; shortName: string; primaryColor: string | null; textColor: string | null; kind: UnavailableKind };

const KINDS: Readonly<Record<string, UnavailableKind>> = { 'tenant.suspended': 'suspended', 'tenant.archived': 'closed', 'tenant.maintenance': 'maintenance' };
/** The problem codes that show the institution's own "unavailable" page rather than an error. */
export const UNAVAILABLE_CODES: readonly string[] = Object.keys(KINDS);

const HEX = /^#[0-9A-Fa-f]{6}$/;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const colour = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v) ? v : null);

/** Read defensively: it's a problem body, and anything odd in it means "no branding", never a crash. */
export function suspendedInstitution(body: unknown): SuspendedInstitution | null {
  const b = body as { code?: unknown; institution?: { legalName?: unknown; shortName?: unknown; primaryColor?: unknown; textColor?: unknown } } | null;
  const kind = typeof b?.code === 'string' ? KINDS[b.code] : undefined;
  if (!b || !kind) return null;
  const i = b.institution;
  if (!i || !text(i.legalName) || !text(i.shortName)) return null;
  const primaryColor = colour(i.primaryColor);
  const textColor = colour(i.textColor);
  return primaryColor && textColor
    ? { legalName: i.legalName, shortName: i.shortName, primaryColor, textColor, kind }
    : { legalName: i.legalName, shortName: i.shortName, primaryColor: null, textColor: null, kind };
}

/**
 * The institution serving this host, or null (unknown host, suspended): from the Host, never input. A suspended one
 * comes back as `suspended`, with its name and colours, so its page says "temporarily unavailable", not "not found".
 */
export async function tenantProfile(): Promise<{ profile: TenantProfile | null; code: string | undefined; suspended: SuspendedInstitution | null }> {
  const res = await serverGet((api) => api.GET('/api/v1/tenant/public-profile'));
  const code = (res.body as { code?: unknown } | null)?.code;
  if (res.data) return { profile: res.data, code: undefined, suspended: null };
  return { profile: null, code: typeof code === 'string' ? code : undefined, suspended: suspendedInstitution(res.body) };
}

export type NoticeList = ResponseBody<'/api/v1/notices', 'get'>['data'];

/**
 * Spec 0037 Q10: this institution's notices. `everyone` is what its sign-in pages show (maintenance); otherwise what the
 * signed-in person sees. A notice is never worth breaking a page for: any failure shows none.
 */
export async function notices(scope: 'everyone' | 'mine'): Promise<NoticeList> {
  try {
    const res = scope === 'everyone' ? await serverGet((api) => api.GET('/api/v1/tenant/notices')) : await serverGet((api) => api.GET('/api/v1/notices'));
    return res.data?.data ?? [];
  } catch {
    return [];
  }
}

export type IncidentList = ResponseBody<'/api/v1/tenant/incidents', 'get'>['data'];

/** Spec 0037 Q14: incidents affecting this institution, for everyone there. Never worth breaking a page for. */
export async function incidents(): Promise<IncidentList> {
  try {
    const res = await serverGet((api) => api.GET('/api/v1/tenant/incidents'));
    return res.data?.data ?? [];
  } catch {
    return [];
  }
}
