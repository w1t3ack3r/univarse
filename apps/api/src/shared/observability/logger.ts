// Spec 0012 OB1/OB2/OB4: one Pino logger, built here for BOTH the API and the worker, so fields, levels,
// redaction and serializers can't drift between them. Every line is one JSON object on stdout.
import type { LoggerService } from '@nestjs/common';
import { pino, type DestinationStream, type Logger as Pino } from 'pino';
import { currentLogContext } from './context.js';
import { scrub, scrubForeign } from './scrub.js';

export type Service = 'api' | 'worker';

export interface LoggerOptions {
  readonly service: Service;
  readonly env: string;
  /** The build's git SHA, or `dev`. */
  readonly version: string;
  readonly level?: string;
  /** Tests capture lines here; default stdout. */
  readonly destination?: DestinationStream;
}

const SECRET_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'code',
  'otp',
  'recoveryCode',
  'recoveryCodes',
  'secret',
  'secretEnc',
  'token',
  'tokenHash',
  'challengeToken',
  'authorization',
  'cookie',
  'set-cookie',
  'accountNumber',
  'nin',
];

/**
 * Pino `redact` paths: each secret key at the top level and up to three levels deep. Keys that aren't
 * identifiers need bracket syntax (`*["set-cookie"]`); a quoted dot path silently matches nothing.
 */
export const REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((k) => {
  const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? { top: k, nested: `.${k}` } : { top: `["${k}"]`, nested: `["${k}"]` };
  return [seg.top, `*${seg.nested}`, `*.*${seg.nested}`, `*.*.*${seg.nested}`];
});

/** Filled by the tracing module (spec 0012 OB9); until then, no span. */
let activeSpanIds: () => { traceId: string | null; spanId: string | null } = () => ({ traceId: null, spanId: null });
export const setActiveSpanIdsProvider = (fn: typeof activeSpanIds): void => {
  activeSpanIds = fn;
};

/** Errors: type, scrubbed message and scrubbed stack. Driver messages can quote values, so foreign scrub. */
/**
 * Machine codes worth keeping: Prisma (`P2002`), Node and system (`ECONNREFUSED`, `ERR_…`), Postgres
 * SQLSTATE (five characters, `23505`) and our dotted problem codes (`auth.mfa_invalid`). A six-digit OTP or
 * reset code matches none of these.
 */
export const isMachineCode = (code: unknown): code is string =>
  typeof code === 'string' && /^(P\d{4}|E[A-Z][A-Z0-9_]+|ERR_[A-Z0-9_]+|[0-9A-Z]{5}|[a-z][a-z0-9_]*(\.[a-z0-9_]+)+)$/.test(code);

/** Shape: `{ type, message, stack?, errorCode? }` for Errors; anything else passes through. */
export function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const code = (err as { code?: unknown }).code;
  return {
    type: err.name,
    message: scrubForeign(err.message),
    ...(err.stack ? { stack: scrubForeign(err.stack) } : {}),
    // `errorCode`, not `code`: `code` is a redacted key (TOTP and reset codes). Only RECOGNIZED machine codes
    // are kept; anything else in `code` (it could be a secret) is dropped.
    ...(isMachineCode(code) ? { errorCode: code } : {}),
  };
}

export function createLogger(opts: LoggerOptions): Pino {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { service: opts.service, env: opts.env, version: opts.version },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
      serializers: { err: serializeError, error: serializeError },
      // OB2: the mandatory fields are always present; unknown is null, never omitted.
      mixin: () => {
        const ctx = currentLogContext();
        return {
          requestId: ctx?.requestId ?? null,
          tenantId: ctx?.tenantId ?? null,
          userId: ctx?.userId ?? null,
          ...activeSpanIds(),
          module: null,
          event: null,
        };
      },
      hooks: {
        // OB4: our own message strings are scrubbed too (URLs, headers, cookies, tokens, signatures).
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as typeof args;
          method.apply(this, cleaned);
        },
      },
    },
    opts.destination,
  );
}

const STACK = /\n\s+at\s/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof Error);

/**
 * Nest's LoggerService onto Pino (D1). Handles Nest's own signatures, where the LAST string parameter is
 * the context (`log(msg, ctx)`, `error(msg, stack, ctx)`), and the object-first shape our call sites use
 * (`warn({ event, … }, msg)`, which Nest's Logger forwards as `(obj, msg, ctx)`).
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly pino: Pino) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  private write(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal', first: unknown, rest: unknown[]): void {
    const params = [...rest];
    let fields: Record<string, unknown> = {};
    let msg: string | undefined;

    if (isObject(first)) {
      // Object first: (obj, msg?, context?)
      fields = { ...first };
      if (typeof params[0] === 'string') msg = params.shift() as string;
    } else if (first instanceof Error) {
      fields = { err: first };
      msg = scrubForeign(first.message); // an error's text is foreign: it may quote values
    } else {
      msg = typeof first === 'string' ? first : String(first);
    }

    // Nest appends the logger's context as the last string parameter.
    const last = params.at(-1);
    if (typeof last === 'string' && !STACK.test(last)) {
      fields.module = last;
      params.pop();
    }
    // error(msg, stack): a stack goes to err.stack, never the message.
    const stack = params.find((p): p is string => typeof p === 'string' && STACK.test(p));
    if (stack && !fields.err) fields.err = { type: 'Error', message: scrubForeign(msg ?? ''), stack: scrubForeign(stack) };
    const errArg = params.find((p): p is Error => p instanceof Error);
    if (errArg && !fields.err) fields.err = errArg;

    this.pino[level](fields, msg ?? '');
  }
}
