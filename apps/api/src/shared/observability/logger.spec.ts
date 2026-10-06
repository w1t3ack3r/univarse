// Spec 0012 OB1/OB2/OB4: the shared logger and the Nest adapter, captured line by line.
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { setLogContext, withLogContext } from './context.js';
import { createLogger, NestPinoLogger, REDACT_PATHS } from './logger.js';
import { scrub, scrubForeign } from './scrub.js';

type Line = Record<string, unknown> & { msg: string; level: string };
function capture(service: 'api' | 'worker' = 'api') {
  const lines: Line[] = [];
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) {
        raw.push(l);
        lines.push(JSON.parse(l) as Line);
      }
      done();
    },
  });
  const pino = createLogger({ service, env: 'test', version: 'abc1234', level: 'trace', destination });
  return { pino, nest: new NestPinoLogger(pino), lines, raw };
}

describe('[OB1] one JSON line per event, from every call shape', () => {
  it('[OB1] Nest normal signatures: log(msg), log(msg, ctx), warn(msg, ctx), debug, verbose', () => {
    const { nest, lines } = capture();
    nest.log('started');
    nest.log('listening', 'Main');
    nest.warn('slow', 'Health');
    nest.debug('detail', 'Cache');
    nest.verbose('very', 'Cache');
    expect(lines.map((l) => [l.level, l.msg, l.module])).toEqual([
      ['info', 'started', null],
      ['info', 'listening', 'Main'],
      ['warn', 'slow', 'Health'],
      ['debug', 'detail', 'Cache'],
      ['trace', 'very', 'Cache'],
    ]);
  });

  it('[OB1] Nest error signatures: error(msg), error(msg, stack), error(msg, stack, ctx), error(err), error(err, ctx)', () => {
    const { nest, lines } = capture();
    const err = new Error('boom');
    nest.error('plain');
    nest.error('with stack', err.stack);
    nest.error('with stack and context', err.stack, 'Errors');
    nest.error(err);
    nest.error(err, 'Errors');
    expect(lines.map((l) => [l.level, l.msg, l.module])).toEqual([
      ['error', 'plain', null],
      ['error', 'with stack', null],
      ['error', 'with stack and context', 'Errors'],
      ['error', 'boom', null],
      ['error', 'boom', 'Errors'],
    ]);
    // A stack never becomes the message; it lands in err.stack.
    for (const l of lines.slice(1)) expect((l.err as { stack: string }).stack).toMatch(/\n\s+at /);
    expect(lines[0]!.err).toBeUndefined();
  });

  it('[OB1] object-first call sites through Nest’s Logger: one line, fields kept, msg and module right', () => {
    const { nest, lines } = capture();
    Logger.overrideLogger(nest);
    try {
      const l = new Logger('FileScanWorker');
      l.warn({ event: 'files.scan.malware_detected', fileId: 'f-1' }, 'Malware detected in an upload');
      l.error({ event: 'files.scan.pass_failed', err: new TypeError('socket hang up') }, 'File scan pass failed');
      l.log('Key sweep done');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'Malware detected in an upload', module: 'FileScanWorker', event: 'files.scan.malware_detected', fileId: 'f-1' });
    expect(lines[1]).toMatchObject({ level: 'error', msg: 'File scan pass failed', module: 'FileScanWorker', err: { type: 'TypeError', message: 'socket hang up' } });
    expect(lines[2]).toMatchObject({ level: 'info', msg: 'Key sweep done', module: 'FileScanWorker' });
  });

  it('[OB1] the API and the worker share the configuration; only `service` differs', () => {
    const api = capture('api');
    const worker = capture('worker');
    api.pino.info({ event: 'x' }, 'm');
    worker.pino.info({ event: 'x' }, 'm');
    const keys = (l: Line) => Object.keys(l).sort();
    expect(keys(api.lines[0]!)).toEqual(keys(worker.lines[0]!));
    expect([api.lines[0]!.service, worker.lines[0]!.service]).toEqual(['api', 'worker']);
  });
});

describe('[OB2] mandatory fields, null when unknown', () => {
  const MANDATORY = ['time', 'level', 'msg', 'service', 'env', 'version', 'module', 'requestId', 'traceId', 'spanId', 'tenantId', 'userId', 'event'];

  it('[OB2] outside any request every field is present; the unknown ones are null', () => {
    const { pino, lines } = capture();
    pino.info('outside');
    for (const k of MANDATORY) expect(lines[0], k).toHaveProperty(k);
    expect(lines[0]).toMatchObject({ service: 'api', env: 'test', version: 'abc1234', requestId: null, tenantId: null, userId: null, traceId: null, spanId: null, event: null });
    expect(String(lines[0]!.time)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('[OB2] inside a context: the request id, then tenant and user as they are resolved', () => {
    const { pino, lines } = capture();
    withLogContext({ requestId: 'req-12345678' }, () => {
      pino.info('before auth');
      setLogContext({ tenantId: 't-a' });
      pino.info('tenant known');
      setLogContext({ userId: 'u-1' });
      pino.info({ event: 'auth.login.succeeded' }, 'signed in');
    });
    expect(lines.map((l) => [l.requestId, l.tenantId, l.userId])).toEqual([
      ['req-12345678', null, null],
      ['req-12345678', 't-a', null],
      ['req-12345678', 't-a', 'u-1'],
    ]);
    expect(lines[2]!.event).toBe('auth.login.succeeded');
  });

  it('[OB2] contexts never bleed: interleaved async work keeps its own fields', async () => {
    const { pino, lines } = capture();
    const step = () => new Promise((r) => setTimeout(r, 1));
    await Promise.all(
      ['a', 'b', 'c'].map((t) =>
        withLogContext({ requestId: `req-${t}xxxxxxx` }, async () => {
          setLogContext({ tenantId: `t-${t}` });
          await step();
          pino.info({ event: 'x' }, t);
          await step();
          setLogContext({ userId: `u-${t}` });
          pino.info({ event: 'y' }, t);
        }),
      ),
    );
    for (const l of lines) expect([l.tenantId, l.requestId]).toEqual([`t-${l.msg}`, `req-${l.msg}xxxxxxx`]);
  });
});

describe('[OB4] secrets cannot be logged', () => {
  it('[OB4] every redacted key, at the top level and nested, becomes [redacted]', () => {
    const { pino, raw } = capture();
    const keys = ['password', 'newPassword', 'code', 'otp', 'recoveryCode', 'recoveryCodes', 'secret', 'token', 'challengeToken', 'authorization', 'cookie', 'set-cookie', 'accountNumber', 'nin'];
    for (const k of keys) {
      pino.info({ [k]: 'S3CRET-VALUE', body: { [k]: 'S3CRET-VALUE', inner: { [k]: 'S3CRET-VALUE' } } }, `key ${k}`);
    }
    expect(raw.join('\n')).not.toContain('S3CRET-VALUE');
    expect(raw.join('\n').match(/\[redacted\]/g)?.length).toBe(keys.length * 3);
    expect(REDACT_PATHS).toContain('*.*.*.password');
  });

  it('[OB4] only recognized machine codes reach err.errorCode; anything else (an OTP in `code`) is dropped', () => {
    const { pino, lines } = capture();
    const coded = (code: unknown) => Object.assign(new Error('failed'), { code });
    for (const code of ['P2002', 'ECONNREFUSED', 'ERR_INVALID_URL', '23505', 'auth.mfa_invalid', '123456', 'hunter2', 42]) pino.error({ err: coded(code) }, String(code));
    expect(lines.map((l) => (l.err as { errorCode?: unknown }).errorCode)).toEqual(['P2002', 'ECONNREFUSED', 'ERR_INVALID_URL', '23505', 'auth.mfa_invalid', undefined, undefined, undefined]);
  });

  it('[OB4] error codes survive (errorCode), while a field named code is redacted', () => {
    const { pino, lines } = capture();
    pino.error({ err: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }), code: '123456' }, 'write failed');
    expect(lines[0]).toMatchObject({ code: '[redacted]', err: { errorCode: 'P2002' } });
  });

  it.each([
    ['a query string on an absolute URL', 'GET https://demo.univarse.ng/api/v1/files?token=abc123 failed', 'GET https://demo.univarse.ng/api/v1/files failed'],
    ['a query string on an /api path', 'fetching /api/v1/users?page=2&q=ada', 'fetching /api/v1/users'],
    ['a Cookie header', 'headers: Cookie: __Host-uv_sid=SESSIONVALUE; theme=dark', 'headers: Cookie: [redacted]'],
    ['an Authorization header', 'Authorization: Bearer eyJhbGciOi.x.y', 'Authorization: [redacted]'],
    ['our cookie by name', 'set __Host-uv_mfa=CHALLENGEVALUE for the challenge', 'set __Host-uv_mfa=[redacted] for the challenge'],
    ['a bearer token', 'used Bearer abc.def.ghi to call', 'used Bearer [redacted] to call'],
    ['a presigned field (JSON)', '{"X-Amz-Signature":"deadbeef","Policy":"eyJ0"}', '{"X-Amz-Signature":"[redacted]","Policy":"[redacted]"}'],
    ['a presigned credential (query style)', 'X-Amz-Credential=AKIA123/2026/us-east-1/s3', 'X-Amz-Credential=[redacted]'],
  ])('[OB4] strings: %s is scrubbed', (_name, input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it('[OB4] foreign text (driver errors, stacks) also hides quoted literals', () => {
    expect(scrubForeign("duplicate key value violates unique constraint: Key (email)=('ada@uni.ng') exists")).toBe(
      "duplicate key value violates unique constraint: Key (email)=('?') exists",
    );
  });

  it('[OB4] scrubbing is applied to messages and error text as they are logged', () => {
    const { pino, nest, raw } = capture();
    // Built at run time: a literal signature-shaped string trips the secret scanner (gitleaks).
    const signed = ['X-Amz-', 'Signature=', 'abc'].join('');
    pino.warn({ event: 'x' }, `called https://s3.local/uv-quarantine?${signed} with Cookie: __Host-uv_sid=SESSIONVALUE`);
    nest.error(new Error("insert failed for 'SECRET-LITERAL' at https://x.test/p?k=v"));
    const all = raw.join('\n');
    for (const s of ['SESSIONVALUE', 'SECRET-LITERAL', signed, 'k=v']) expect(all, s).not.toContain(s);
  });
});
