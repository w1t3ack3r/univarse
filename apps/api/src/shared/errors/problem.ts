// RFC 9457 Problem Details (docs/06-api-guidelines.md §4).

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: { path: string; code: string; message: string }[];
  /** Spec 0037 Q8: a suspended institution's public name and colours (423 tenant.suspended only), never personal data. */
  institution?: SuspendedInstitution;
}

export interface SuspendedInstitution {
  legalName: string;
  shortName: string;
  primaryColor: string | null;
  textColor: string | null;
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
