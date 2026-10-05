import { serverApi } from './server-api';

export interface TenantProfile {
  readonly slug: string;
  readonly shortName: string;
  readonly legalName: string;
  readonly type: string;
}

/** The institution serving this host, or null (unknown host, suspended): from the Host, never input. */
export async function tenantProfile(): Promise<{ profile: TenantProfile | null; code: string | undefined }> {
  const res = await serverApi<TenantProfile & { code?: string }>('/api/v1/tenant/public-profile');
  return res.status === 200 ? { profile: res.body, code: undefined } : { profile: null, code: res.body?.code };
}
