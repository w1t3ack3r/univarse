// Spec 0012 OB9: tracing starts BEFORE any instrumented library loads. The compiled start commands load this
// first: `node --import ./dist/otel.js dist/main.js` (and `dist/worker.js`). Late initialization can leave
// instrumentation silently inactive, so nothing else may import pg, ioredis, Prisma or Fastify earlier.
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { createAddHookMessageChannel } from 'import-in-the-middle';

// Local dev convenience, as in main.ts/worker.ts: the repo-root .env (never in production).
const rootEnv = new URL('../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { registerOptions } = createAddHookMessageChannel();
// eslint-disable-next-line @typescript-eslint/no-deprecated -- import-in-the-middle's hook is an async loader; it needs `register`
register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

const { exportBoundsFromEnv, startTracing } = await import('./shared/observability/tracing.js');
const { createLogger } = await import('./shared/observability/logger.js');
const env = process.env.NODE_ENV ?? 'development';
const service = /worker\.js$/.test(process.argv[1] ?? '') ? 'worker' : 'api';
const version = process.env.UNIVARSE_VERSION ?? 'dev';
// OB11: export trouble is reported on the process's own JSON log stream, at most once a minute.
const log = createLogger({ service, env, version, level: process.env.LOG_LEVEL ?? 'info' });
// D3: 100% outside production; a provisional 10% in production. Children follow their parent's decision.
const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? (env === 'production' ? 0.1 : 1));
startTracing({
  service,
  env,
  version,
  // OB11: export only when an endpoint is configured; otherwise nothing leaves the process.
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  // Unset in production (EXPORT_BOUNDS apply); the OB12 shutdown test lengthens the delay (OTEL_BSP_*).
  bounds: exportBoundsFromEnv(process.env),
  ratio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1,
  onExportDegraded: (d) => log.warn({ event: 'otel.export_degraded', ...d }, 'Trace export is degraded: spans dropped or exports failed since the last report'),
});
// No `await waitForAllMessagesAcknowledged()` here: inside a `--import` preload it never resolves (the process
// hangs before the app starts; seen 2026-10-07). `register` installs the hook synchronously, and the compiled
// process is proved fully instrumented anyway: OB12 asserts pg and Valkey spans from dist/main.js and
// dist/worker.js. (The in-process test helper does wait; there it resolves.)
