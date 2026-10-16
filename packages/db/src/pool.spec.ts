// Spec 0017 PB7: PgBouncer's query_wait_timeout is "no connection in time" (503 server.busy), matched narrowly.
// The fixtures are the error captured on 2026-10-14 (Prisma 7.10 through PgBouncer 1.26.1, probe profile), built
// with Prisma's real error class. The live halves (through PgBouncer, through the API) are in the probe file.
import { describe, expect, it } from 'vitest';
import { Prisma } from './generated/platform/client.js';
import { isConnectionUnavailable } from './pool.js';

/** The driver adapter error as captured: an Error named DriverAdapterError, its cause PgBouncer's FATAL. */
function adapterError(
  over: Record<string, unknown> = {},
  message = 'query_wait_timeout',
  name = 'DriverAdapterError',
) {
  const e = new Error(message, {
    cause: {
      originalCode: '08P01',
      originalMessage: 'query_wait_timeout',
      kind: 'postgres',
      code: '08P01',
      severity: 'FATAL',
      message: 'query_wait_timeout',
      ...over,
    },
  });
  e.name = name;
  return e;
}

/** The PrismaClientKnownRequestError as captured (P2039), with its meta. */
const captured = (
  driverAdapterError: unknown = adapterError(),
  code = 'P2039',
  meta: Record<string, unknown> = {},
) =>
  new Prisma.PrismaClientKnownRequestError(
    'Database error. Code: `08P01`. Message: `query_wait_timeout`',
    {
      code,
      clientVersion: '7.10.0',
      meta: { modelName: 'Tenant', driverAdapterError, ...meta },
    },
  );

describe("[PB7] PgBouncer's query_wait_timeout is shed as server.busy, matched narrowly", () => {
  it('matches the captured error: outside a transaction (with a model) and at a transaction start (without)', () => {
    expect(isConnectionUnavailable(captured())).toBe(true);
    const atTransactionStart = new Prisma.PrismaClientKnownRequestError(
      'Database error. Code: `08P01`. Message: `query_wait_timeout`',
      { code: 'P2039', clientVersion: '7.10.0', meta: { driverAdapterError: adapterError() } },
    );
    expect(isConnectionUnavailable(atTransactionStart)).toBe(true);
  });

  it("refuses PgBouncer's other 08P01 errors, which aren't queue timeouts", () => {
    for (const other of [
      'no more connections allowed (max_client_conn)',
      'server login has been failing, cached error: connect failed (server_login_retry)',
      'query_timeout',
      'client_idle_timeout',
      'query_wait_timeout ', // not the exact text
    ]) {
      const e = captured(adapterError({ originalMessage: other, message: other }, other));
      expect(isConnectionUnavailable(e), other).toBe(false);
    }
  });

  it('refuses any field differing from the capture', () => {
    const variants: [string, unknown][] = [
      ['another code', captured(adapterError(), 'P2010')],
      ['an ERROR, not FATAL', captured(adapterError({ severity: 'ERROR' }))],
      ['another SQLSTATE', captured(adapterError({ code: '57014', originalCode: '57014' }))],
      ['only code changed', captured(adapterError({ code: '57014' }))],
      ['only originalCode changed', captured(adapterError({ originalCode: '57014' }))],
      [
        'only originalMessage changed',
        captured(adapterError({ originalMessage: 'query_wait_timeout_extended' })),
      ],
      ['not from postgres', captured(adapterError({ kind: 'mysql' }))],
      ['another adapter message', captured(adapterError({}, 'something else'))],
      ['not a DriverAdapterError', captured(adapterError({}, 'query_wait_timeout', 'Error'))],
      [
        'a plain object, not an Error',
        captured({ name: 'DriverAdapterError', message: 'query_wait_timeout', cause: {} }),
      ],
      ['no adapter error', captured(null)], // null: undefined would take the default
      [
        'no cause',
        captured(Object.assign(new Error('query_wait_timeout'), { name: 'DriverAdapterError' })),
      ],
    ];
    for (const [label, e] of variants) expect(isConnectionUnavailable(e), label).toBe(false);
  });

  it('refuses look-alikes that are not Prisma errors: the same fields on another class, or the bare message', () => {
    const lookAlike = Object.assign(
      new Error('Database error. Code: `08P01`. Message: `query_wait_timeout`'),
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2039',
        meta: { driverAdapterError: adapterError() },
      },
    );
    expect(isConnectionUnavailable(lookAlike)).toBe(false);
    expect(isConnectionUnavailable(new Error('query_wait_timeout'))).toBe(false);
    expect(
      isConnectionUnavailable({ code: 'P2039', meta: { driverAdapterError: adapterError() } }),
    ).toBe(false);
  });

  it('keeps the existing matches: P2028 at transaction start, and the pg connection timeout', () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.',
      { code: 'P2028', clientVersion: '7.10.0' },
    );
    expect(isConnectionUnavailable(p2028)).toBe(true);
    expect(
      isConnectionUnavailable(new Error('Connection terminated due to connection timeout')),
    ).toBe(true);
    expect(isConnectionUnavailable(new Error('connection refused'))).toBe(false);
  });
});
