// Spec 0011 OA11: the conformance check must actually catch drift. Each case feeds it one wrong response
// against the committed document; the correct version of each passes.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { problemType } from '../shared/errors/problem.js';
import { checkResponse, type WireResponse } from './conformance.js';

const id = randomUUID();
const now = new Date().toISOString();
const fileView = { id, name: 'a.pdf', sizeBytes: 3, state: 'CLEAN', type: 'application/pdf', rejectionReason: null, createdAt: now, scannedAt: now };
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'cache-control': 'no-store',
};
const json = (statusCode: number, body: unknown, headers: Record<string, string | string[]> = {}, media = 'application/json'): WireResponse => ({
  statusCode,
  headers: { 'content-type': `${media}; charset=utf-8`, ...SECURITY, ...headers },
  rawPayload: Buffer.from(JSON.stringify(body)),
});
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { type: problemType(code), title: 'x', status, code, requestId: 'req-1', ...extra }, {}, 'application/problem+json');
const pdf = (bytes: Buffer, headers: Record<string, string> = {}): WireResponse => ({
  statusCode: 200,
  headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'content-disposition': 'attachment; filename="a.pdf"', ...SECURITY, ...headers },
  rawPayload: bytes,
});
const setting = {
  key: 'files.storageQuotaBytes',
  label: 'Storage',
  value: 1024,
  default: 1024,
  source: 'tenant',
  version: 3,
  updatedAt: now,
  updatedBy: null,
  canManage: true,
};
const cookie = '__Host-uv_sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800';

describe('[OA10] correct responses pass', () => {
  it.each([
    ['GET', `/api/v1/files/${id}`, json(200, fileView)],
    ['GET', `/api/v1/files/${id}/content`, pdf(Buffer.from('%PDF-1.4'))],
    ['DELETE', `/api/v1/files/${id}`, { statusCode: 204, headers: SECURITY, rawPayload: Buffer.alloc(0) }],
    ['POST', '/api/v1/files/uploads', problem(409, 'file.quota_exceeded')],
    ['POST', '/api/v1/files/uploads', problem(400, 'request.invalid', { errors: [{ path: 'name', code: 'too_small', message: 'x' }] })],
    ['GET', '/api/v1/settings/files.storageQuotaBytes', json(200, setting, { etag: '"v3"' })],
    ['POST', '/api/v1/auth/step-up', json(200, { stepUp: true }, { 'set-cookie': cookie })],
    ['POST', '/api/v1/auth/login', json(429, { type: problemType('request.rate_limited'), title: 'x', status: 429, code: 'request.rate_limited', requestId: 'r' }, { 'retry-after': '60' }, 'application/problem+json')],
  ] as const)('[OA10] %s %s', (method, url, res) => {
    expect(checkResponse(method, url, res)).toEqual([]);
  });
});

describe('[OA11] each kind of drift is caught', () => {
  const fails = (method: string, url: string, res: WireResponse, pattern: RegExp) => {
    const problems = checkResponse(method, url, res);
    expect(problems.join('\n')).toMatch(pattern);
  };

  it('[OA11] a renamed response field', () => {
    const { name, ...rest } = fileView;
    fails('GET', `/api/v1/files/${id}`, json(200, { ...rest, fileName: name }), /body does not match/);
  });

  it('[OA11] an undocumented status', () => {
    fails('GET', `/api/v1/files/${id}`, json(202, fileView), /status not documented/);
  });

  it('[OA11] an error code the operation does not document', () => {
    fails('POST', '/api/v1/files/uploads', problem(409, 'file.not_ready'), /body does not match/);
  });

  it('[OA11] a Problem whose type is not problemType(code)', () => {
    fails('POST', '/api/v1/files/uploads', { ...problem(409, 'file.quota_exceeded') }, /^$/); // control: correct passes
    const wrong = json(409, { type: 'about:blank', title: 'x', status: 409, code: 'file.quota_exceeded', requestId: 'r' }, {}, 'application/problem+json');
    fails('POST', '/api/v1/files/uploads', wrong, /is not problemType/);
  });

  it('[OA11] a 204 that returns a body', () => {
    fails('DELETE', `/api/v1/files/${id}`, { statusCode: 204, headers: SECURITY, rawPayload: Buffer.from('{}') }, /documented as empty/);
  });

  it('[OA11] a download whose Content-Length does not match its payload', () => {
    fails('GET', `/api/v1/files/${id}/content`, pdf(Buffer.from('%PDF-1.4'), { 'content-length': '999' }), /Content-Length 999 but the payload is 8 bytes/);
  });

  it('[OA11] a download with an undocumented type, or without its safety headers', () => {
    fails('GET', `/api/v1/files/${id}/content`, pdf(Buffer.from('<html>'), { 'content-type': 'text/html' }), /content-type text\/html not documented/);
    const noSniffless = pdf(Buffer.from('%PDF-1.4'));
    delete (noSniffless.headers as Record<string, unknown>)['x-content-type-options'];
    fails('GET', `/api/v1/files/${id}/content`, noSniffless, /header X-Content-Type-Options missing/);
    fails('GET', `/api/v1/files/${id}/content`, pdf(Buffer.from('%PDF-1.4'), { 'content-disposition': 'inline' }), /Content-Disposition/);
  });

  it('[OA11] a settings read without its ETag, or a value that does not fit its key', () => {
    fails('GET', '/api/v1/settings/files.storageQuotaBytes', json(200, setting), /header ETag missing/);
    fails('GET', '/api/v1/settings/files.storageQuotaBytes', json(200, { ...setting, value: { min: 1, max: 2 } }, { etag: '"v3"' }), /body does not match/);
  });

  it('[OA11] a session cookie without HttpOnly, or an undocumented cookie', () => {
    fails('POST', '/api/v1/auth/step-up', json(200, { stepUp: true }, { 'set-cookie': cookie.replace('; HttpOnly', '') }), /lacks HttpOnly/);
    fails('POST', '/api/v1/auth/step-up', json(200, { stepUp: true }, { 'set-cookie': [cookie, 'tracker=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1'] }), /undocumented cookie tracker/);
  });

  it('[OA11] a 429 without Retry-After', () => {
    fails('POST', '/api/v1/auth/login', problem(429, 'request.rate_limited'), /header Retry-After missing/);
  });
});
