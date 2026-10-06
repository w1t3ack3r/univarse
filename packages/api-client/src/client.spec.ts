// Spec 0011 OA8: the shared behaviour every call gets from the client, against a fake fetch.
import type { SettingValue } from '@univarse/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { answer, ApiError, contentUrl, createApi, unwrap, type paths } from './client.js';
import { getSetting, putSetting, type SettingViewOf } from './settings.js';

type Handler = (req: Request) => Response | Promise<Response>;
const seen: Request[] = [];
const api = (handler: Handler, baseUrl = 'http://api.test') =>
  createApi({
    baseUrl,
    credentials: 'same-origin',
    fetch: async (input, init) => {
      const req = new Request(input, init);
      seen.push(req);
      return handler(req);
    },
  });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { type: `https://docs.univarse.ng/errors/${code}`, title: 't', status, code, requestId: 'req-from-body', ...extra });
const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

describe('[OA8] failures become typed ApiErrors with the support reference', () => {
  it('[OA8] no answer at all (network) is network.offline', async () => {
    const err = await caught(unwrap(api(() => Promise.reject(new TypeError('fetch failed'))).GET('/api/v1/files')));
    expect(err).toBeInstanceOf(ApiError);
    expect([(err as ApiError).status, (err as ApiError).code]).toEqual([0, 'network.offline']);
  });

  it('[OA8] a non-JSON answer (a proxy 502 page) is server.unexpected_response with x-request-id, not a SyntaxError', async () => {
    const html = () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html', 'x-request-id': 'req-proxy-1' } });
    const err = (await caught(unwrap(api(html).GET('/api/v1/files')))) as ApiError;
    expect([err.name, err.status, err.code, err.requestId]).toEqual(['ApiError', 502, 'server.unexpected_response', 'req-proxy-1']);
    expect(err.message).toBe('Something went wrong on our side. Please try again in a moment.');
  });

  it('[OA8] a JSON content type with a truncated body is server.unexpected_response too', async () => {
    const cut = () => new Response('{"data": [', { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-cut-1' } });
    expect(await caught(unwrap(api(cut).GET('/api/v1/files')))).toMatchObject({ status: 200, code: 'server.unexpected_response', requestId: 'req-cut-1' });
  });

  it('[OA8] Problem Details: status, code, field errors and the request id; message by code, never detail', async () => {
    const res = () => problem(400, 'request.invalid', { detail: 'internal words', errors: [{ path: 'name', code: 'too_small', message: 'x' }] });
    const err = (await caught(unwrap(api(res).POST('/api/v1/files/uploads', { body: { name: '', mime: 'application/pdf', sizeBytes: 1 } })))) as ApiError;
    expect([err.status, err.code, err.requestId, err.fieldErrors]).toEqual([400, 'request.invalid', 'req-from-body', [{ path: 'name', code: 'too_small', message: 'x' }]]);
    expect(err.message).toBe('Some details are missing or not valid.');
  });

  it('[OA8] a Problem without a body request id falls back to the x-request-id header', async () => {
    const res = () => json(409, { type: 't', title: 't', status: 409, code: 'file.quota_exceeded' }, { 'x-request-id': 'req-header-1' });
    expect(await caught(unwrap(api(res).POST('/api/v1/files/uploads', { body: { name: 'a.pdf', mime: 'application/pdf', sizeBytes: 1 } })))).toMatchObject({
      code: 'file.quota_exceeded',
      requestId: 'req-header-1',
    });
  });
});

describe('[OA8] empty, binary, cookies and CSRF', () => {
  it('[OA8] a 204 is not parsed: unwrap resolves with no data', async () => {
    const res = () => new Response(null, { status: 204 });
    await expect(unwrap(api(res).DELETE('/api/v1/files/{id}', { params: { path: { id: 'f-1' } } }))).resolves.toBeUndefined();
  });

  it('[OA8] browser calls are same-origin with credentials, ask for JSON, and send JSON bodies', async () => {
    seen.length = 0;
    // In the browser the base is '' (same origin); Node needs an absolute URL, so the origin stands in.
    await unwrap(api(() => json(200, { stepUp: true }), 'http://demo-uni.univarse.localhost').POST('/api/v1/auth/step-up', { body: { password: 'p' } }));
    const req = seen[0]!;
    expect([req.credentials, req.headers.get('accept'), req.headers.get('content-type')]).toEqual(['same-origin', 'application/json', 'application/json']);
  });

  it('[OA8] the binary download is a link built from the documented path, never fetched or parsed', () => {
    expect(contentUrl('a/b c')).toBe('/api/v1/files/a%2Fb%20c/content');
    expectTypeOf<'/api/v1/files/{id}/content'>().toExtend<keyof paths>();
  });
});

describe('[OA8] typed outcomes', () => {
  it('[OA8] login has both outcomes in its type: a session (user) or an MFA challenge', async () => {
    type Login = Awaited<ReturnType<typeof unwrap<paths['/api/v1/auth/login']['post']['responses'][200]['content']['application/json']>>>;
    expectTypeOf<{ mfaRequired: true }>().toExtend<Login>();
    expectTypeOf<{ user: { id: string; username: string; displayName: string } }>().toExtend<Login>();
    const challenge = await unwrap(api(() => json(200, { mfaRequired: true })).POST('/api/v1/auth/login', { body: { username: 'u', password: 'p' } }));
    expect('mfaRequired' in challenge && challenge.mfaRequired).toBe(true);
  });

  it('[OA8] answer() gives server pages status, body and request id without throwing for HTTP outcomes', async () => {
    expect(await answer(api(() => problem(401, 'auth.unauthenticated', {}), 'http://api').GET('/api/v1/auth/me'))).toMatchObject({ status: 401, body: { code: 'auth.unauthenticated' } });
    const html = () => new Response('<h1>502</h1>', { status: 502, headers: { 'content-type': 'text/html', 'x-request-id': 'req-502-1' } });
    expect(await answer(api(html).GET('/api/v1/auth/me'))).toEqual({ status: 502, body: null, data: undefined, requestId: 'req-502-1' });
    await expect(answer(api(() => Promise.reject(new TypeError('down'))).GET('/api/v1/auth/me'))).rejects.toMatchObject({ code: 'network.offline' });
  });
});

describe('[OA8] settings: the key picks the value type; writes send If-Match and return the new ETag', () => {
  const view = { key: 'registration.unitLimits', label: 'Units', value: { min: 15, max: 24 }, default: { min: 15, max: 24 }, source: 'tenant', version: 4, updatedAt: null, updatedBy: null, canManage: true };

  it('[OA8] types: the value for a key is that key’s registry type, and the view narrows to that key', () => {
    expectTypeOf<SettingViewOf<'registration.unitLimits'>['value']>().toEqualTypeOf<{ min: number; max: number }>();
    expectTypeOf<SettingViewOf<'files.storageQuotaBytes'>['value']>().toEqualTypeOf<number>();
    expectTypeOf<Parameters<typeof putSetting<'files.storageQuotaBytes'>>[2]>().toEqualTypeOf<SettingValue<'files.storageQuotaBytes'>>();
  });

  it('[OA8] a write sends If-Match and returns the new ETag; a read returns its ETag', async () => {
    seen.length = 0;
    const client = api((req) => json(200, { ...view, version: req.method === 'PUT' ? 5 : 4 }, { etag: req.method === 'PUT' ? '"v5"' : '"v4"' }));
    const read = await getSetting(client, 'registration.unitLimits');
    expect([read.view.value, read.etag]).toEqual([{ min: 15, max: 24 }, '"v4"']);
    const written = await putSetting(client, 'registration.unitLimits', { min: 12, max: 20 }, read.etag);
    expect(written.etag).toBe('"v5"');
    const put = seen.find((r) => r.method === 'PUT')!;
    expect([put.url, put.headers.get('if-match'), await put.json()]).toEqual(['http://api.test/api/v1/settings/registration.unitLimits', '"v4"', { value: { min: 12, max: 20 } }]);
  });

  it('[OA8] a stale write surfaces 412 precondition.failed as an ApiError', async () => {
    const err = await caught(putSetting(api(() => problem(412, 'precondition.failed')), 'registration.unitLimits', { min: 1, max: 2 }, '"v1"'));
    expect(err).toMatchObject({ status: 412, code: 'precondition.failed' });
  });
});
