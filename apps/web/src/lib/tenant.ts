import type { ResponseBody } from '@univarse/api-client';
import { serverGet } from './server-api';

export type TenantProfile = ResponseBody<'/api/v1/tenant/public-profile', 'get'>;

/** The institution serving this host, or null (unknown host, suspended): from the Host, never input. */
export async function tenantProfile(): Promise<{ profile: TenantProfile | null; code: string | undefined }> {
  const res = await serverGet((api) => api.GET('/api/v1/tenant/public-profile'));
  const code = (res.body as { code?: unknown } | null)?.code;
  return res.data ? { profile: res.data, code: undefined } : { profile: null, code: typeof code === 'string' ? code : undefined };
}
