/**
 * The environment the console names in its bar (docs/11 §9: a clearly labelled banner). Every UniVarse environment is
 * local today (ADR-030); STAGING and PRODUCTION wait for hosting. Anything unrecognised is shown as LOCAL, never as
 * PRODUCTION: mistaking a test console for the real one is the safe error.
 */
export const ENVIRONMENTS = ['LOCAL', 'STAGING', 'PRODUCTION'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function environmentOf(raw: string | undefined): Environment {
  const v = raw?.trim().toUpperCase();
  return (ENVIRONMENTS as readonly string[]).includes(v ?? '') ? (v as Environment) : 'LOCAL';
}
