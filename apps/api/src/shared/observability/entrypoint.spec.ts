import { describe, expect, it } from 'vitest';
import { loadsRootEnv, serviceOf } from './entrypoint.js';

describe('the tracing preload’s entrypoint (spec 0027 P1, P5)', () => {
  it('names the process from its entry script, on any platform', () => {
    expect(serviceOf('/app/dist/main.js')).toBe('api');
    expect(serviceOf('/app/dist/worker.js')).toBe('worker');
    expect(serviceOf('/app/dist/platform.js')).toBe('platform-api');
    expect(serviceOf('C:\\repo\\apps\\api\\dist\\platform.js')).toBe('platform-api');
    expect(serviceOf(undefined)).toBe('api');
    // A look-alike is not the platform API.
    expect(serviceOf('/app/dist/not-platform.js')).toBe('api');
  });

  it('never loads the repo-root .env for the platform API, and never in production', () => {
    expect(loadsRootEnv('platform-api', 'development')).toBe(false);
    expect(loadsRootEnv('api', 'development')).toBe(true);
    expect(loadsRootEnv('worker', undefined)).toBe(true);
    expect(loadsRootEnv('api', 'production')).toBe(false);
  });
});
