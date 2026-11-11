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

/** The institution serving this host, or null (unknown host, suspended): from the Host, never input. */
export async function tenantProfile(): Promise<{ profile: TenantProfile | null; code: string | undefined }> {
  const res = await serverGet((api) => api.GET('/api/v1/tenant/public-profile'));
  const code = (res.body as { code?: unknown } | null)?.code;
  return res.data ? { profile: res.data, code: undefined } : { profile: null, code: typeof code === 'string' ? code : undefined };
}
