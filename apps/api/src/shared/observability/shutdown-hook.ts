// Spec 0012 OB11: a Nest lifecycle hook that runs a function when the app or worker context closes.
// `onApplicationShutdown` hooks run after the HTTP server and connections are closed, so the spans of the
// last requests and jobs have ended by the time traces are flushed.
import type { OnApplicationShutdown, Provider } from '@nestjs/common';

export const SHUTDOWN_HOOK = Symbol('SHUTDOWN_HOOK');

export const shutdownHook = (fn: () => Promise<void>): Provider => ({
  provide: SHUTDOWN_HOOK,
  useValue: { onApplicationShutdown: () => fn() } satisfies OnApplicationShutdown,
});
