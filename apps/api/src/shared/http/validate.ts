import type { z } from 'zod';
import { ProblemError } from '../errors/problem.js';

export class ValidationProblem extends ProblemError {
  constructor(readonly errors: { path: string; code: string; message: string }[]) {
    super(400, 'request.invalid', 'Invalid request');
  }
}

/** Parses untrusted input with a strict zod schema; unknown fields are rejected (docs/06 §2). */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new ValidationProblem(
    r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
  );
}
