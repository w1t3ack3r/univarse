// RFC 9457 Problem Details (docs/06-api-guidelines.md §4).

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: { path: string; code: string; message: string }[];
}

/** Throw from anywhere to return a specific problem response. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
  }
}

export const problemType = (code: string) => `https://docs.univarse.ng/errors/${code.replaceAll('_', '-')}`;
