/**
 * Which process the tracing preload (otel.ts) is starting, from its entry script. Pure, and free of instrumented
 * imports, so the preload can call it before registering its hooks. Spec 0027 P1, P5: the platform API is its own
 * service, and it never loads the repo-root .env in development (that file holds the tenant API's secrets).
 */
export type EntryService = 'api' | 'worker' | 'platform-api';

export function serviceOf(entry: string | undefined): EntryService {
  const file = (entry ?? '').replace(/\\/g, '/').split('/').at(-1) ?? '';
  if (file === 'worker.js') return 'worker';
  if (file === 'platform.js') return 'platform-api';
  return 'api';
}

/** Whether the preload may load the repo-root .env: in development, and never for the platform API. */
export const loadsRootEnv = (service: EntryService, nodeEnv: string | undefined): boolean => nodeEnv !== 'production' && service !== 'platform-api';
