import { describe, expect, it } from 'vitest';
import { ApiUnavailableError, checkSession, problemFromDigest, type Me } from './session-check';

const me: Me = { id: 'u1', username: 'ADA', displayName: 'Ada', mfa: true, restricted: false, permissions: [] };
const REQ = '01J9ZREQUEST0001';
const problem = (status: number, code: string) => ({ status, body: { status, code, requestId: REQ }, requestId: REQ });

describe('[W7] /auth/me status → page behaviour', () => {
  it('200 with a user is signed in', () => {
    expect(checkSession({ status: 200, body: me, requestId: REQ })).toEqual({ kind: 'signed-in', me });
  });

  it('401 — and only 401 — is signed out', () => {
    expect(checkSession(problem(401, 'auth.unauthenticated'))).toEqual({ kind: 'signed-out' });
    expect(checkSession({ status: 401, body: null, requestId: undefined })).toEqual({ kind: 'signed-out' });
  });

  it.each([500, 502, 503, 504])('%i is the error state with the support reference, never a sign-out', (status) => {
    expect(checkSession(problem(status, 'server.internal'))).toEqual({ kind: 'unavailable', code: 'server.internal', requestId: REQ });
  });

  it.each([
    [403, 'auth.forbidden'],
    [404, 'tenant.not_found'],
    [423, 'tenant.suspended'],
    [429, 'request.rate_limited'],
  ])('%i keeps its problem code (%s) instead of looking signed out', (status, code) => {
    expect(checkSession(problem(status, code))).toEqual({ kind: 'unavailable', code, requestId: REQ });
  });

  it('a network failure (no answer) is the error state, not a sign-out', () => {
    expect(checkSession('unreachable')).toEqual({ kind: 'unavailable', code: 'network.unreachable', requestId: undefined });
  });

  it('a non-JSON 5xx (proxy page) falls back to the x-request-id header and a generic code', () => {
    expect(checkSession({ status: 502, body: null, requestId: REQ })).toEqual({ kind: 'unavailable', code: 'server.internal', requestId: REQ });
  });

  it('a 200 without a usable user is not trusted as signed in', () => {
    expect(checkSession({ status: 200, body: null, requestId: REQ }).kind).toBe('unavailable');
    expect(checkSession({ status: 200, body: { id: 'u1' }, requestId: REQ }).kind).toBe('unavailable');
  });

  it('never carries an unsafe code or reference to the page', () => {
    const odd = { status: 500, body: { code: '<script>', requestId: 'a b:c' }, requestId: undefined };
    expect(checkSession(odd)).toEqual({ kind: 'unavailable', code: 'server.internal', requestId: undefined });
  });
});

describe('[W7] the problem reaches the error boundary through the digest', () => {
  it('round-trips code and support reference', () => {
    const err = new ApiUnavailableError('server.internal', REQ);
    expect(problemFromDigest(err.digest)).toEqual({ code: 'server.internal', requestId: REQ });
  });

  it('round-trips without a reference', () => {
    expect(problemFromDigest(new ApiUnavailableError('network.unreachable', undefined).digest)).toEqual({
      code: 'network.unreachable',
      requestId: undefined,
    });
  });

  it('any other crash (Next’s own hash digest, or none) is a generic problem without a reference', () => {
    expect(problemFromDigest('2738940123')).toEqual({ code: 'server.internal', requestId: undefined });
    expect(problemFromDigest(undefined)).toEqual({ code: 'server.internal', requestId: undefined });
    expect(problemFromDigest('uv-problem:../x:zz')).toEqual({ code: 'server.internal', requestId: undefined });
  });
});
