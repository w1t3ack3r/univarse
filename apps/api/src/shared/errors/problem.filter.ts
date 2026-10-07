import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { isConnectionUnavailable } from '@univarse/db';
import { DomainError } from '@univarse/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, problemType, type ProblemBody } from './problem.js';

const TITLES: Record<number, [string, string]> = {
  400: ['request.invalid', 'Bad request'],
  401: ['auth.unauthenticated', 'Authentication required'],
  403: ['auth.forbidden', 'Forbidden'],
  404: ['resource.not_found', 'Not found'],
  405: ['request.method_not_allowed', 'Method not allowed'],
  413: ['request.too_large', 'Payload too large'],
  415: ['request.unsupported_media_type', 'Unsupported media type'],
  429: ['request.rate_limited', 'Too many requests'],
};

/**
 * `Retry-After` on every 503 (ADR-026): about one transaction wait (2 s), long enough for a shard's
 * connection queue to drain. Readiness 503s carry it too; probes ignore it.
 */
export const UNAVAILABLE_RETRY_AFTER_SEC = 2;

/** Maps every error to application/problem+json. Never leaks stack traces or internals. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const body = this.toProblem(exception);
    body.requestId = req.id;

    const retryAfter = (exception as { retryAfterSec?: number } | null)?.retryAfterSec;
    if (body.status === 429 && retryAfter) void reply.header('retry-after', String(retryAfter));

    if (body.status === 503) void reply.header('retry-after', String(UNAVAILABLE_RETRY_AFTER_SEC));

    if (body.code === 'server.busy') {
      // ADR-026: no database connection in time. Backpressure, not a bug: a capacity signal for humans.
      this.logger.warn({ event: 'db.connection_unavailable', err: exception }, 'No database connection available in time');
    } else if (body.status >= 500) {
      this.logger.error({ event: 'http.unhandled_error', err: exception }, 'Unhandled error');
    }
    void reply.status(body.status).header('content-type', 'application/problem+json').send(body);
  }

  private toProblem(e: unknown): ProblemBody {
    if (e instanceof ProblemError) {
      const errors = (e as ProblemError & { errors?: ProblemBody['errors'] }).errors;
      return {
        type: problemType(e.code),
        title: e.title,
        status: e.status,
        code: e.code,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(errors ? { errors } : {}),
      };
    }
    if (e instanceof DomainError) {
      return { type: problemType(e.code), title: 'Business rule violation', status: 422, code: e.code, detail: e.message };
    }
    if (isConnectionUnavailable(e)) {
      return { type: problemType('server.busy'), title: 'Service busy, retry shortly', status: 503, code: 'server.busy' };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const [code, title] = TITLES[status] ?? ['request.error', 'Request error'];
      return { type: problemType(code), title, status, code };
    }
    return { type: problemType('server.internal'), title: 'Internal server error', status: 500, code: 'server.internal' };
  }
}
