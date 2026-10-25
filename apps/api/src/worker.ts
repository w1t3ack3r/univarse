import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config/config.js';
import { FileScanWorker } from './modules/files/file-scan.worker.js';
import { KeyMaintenance } from './shared/crypto/key-maintenance.js';
import { PlatformInvalidationRelay } from './shared/infra/platform-invalidation-relay.js';
import { OutboxWorker } from './shared/outbox/outbox-worker.js';
import { createLogger, NestPinoLogger } from './shared/observability/logger.js';
import { shutdownTracing } from './shared/observability/tracing.js';
import { WorkerModule } from './worker.module.js';

// Local dev convenience: repo-root .env. In deployed environments, env comes from the secret manager.
const rootEnv = new URL('../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
// Spec 0016 IO17: the relay role's URL lives in .env.worker, which only this entrypoint loads (never the API's).
const workerEnv = new URL('../../../.env.worker', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(workerEnv)) process.loadEnvFile(workerEnv);

const config = loadConfig(process.env, 'worker');
// Spec 0016: the worker relays the platform invalidation events, so it doesn't start without the relay's role.
if (!config.PLATFORM_RELAY_URL) throw new Error('PLATFORM_RELAY_URL is not set: run `pnpm db:setup`, which writes it to .env.worker');
// Spec 0012 OB1: the same logger configuration as the API, as service `worker`.
const log = createLogger({ service: 'worker', env: config.NODE_ENV, version: config.UNIVARSE_VERSION, level: config.LOG_LEVEL });
const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, { onShutdown: shutdownTracing, renewVaultToken: true }), { logger: new NestPinoLogger(log) });
const worker = ctx.get(OutboxWorker);
worker.start(config.WORKER_POLL_MS);
// Separate loop: a long key sweep never delays email.
const keys = ctx.get(KeyMaintenance);
keys.start(config.KEY_SWEEP_INTERVAL_MS);
// Separate loop again: a slow or unavailable scanner never delays email or the key sweep.
const scans = ctx.get(FileScanWorker);
scans.start(config.FILE_SCAN_INTERVAL_MS);
// And again: platform invalidations every 250 ms, never behind email, keys or scans (spec 0016 D4).
const relay = ctx.get(PlatformInvalidationRelay);
relay.start();
new Logger('Worker').log({ event: 'worker.started', pollMs: config.WORKER_POLL_MS }, `UniVarse worker polling the outbox every ${String(config.WORKER_POLL_MS)} ms (${config.NODE_ENV})`);

const shutdown = async () => {
  await Promise.all([worker.stop(), keys.stop(), scans.stop(), relay.stop()]);
  await ctx.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
