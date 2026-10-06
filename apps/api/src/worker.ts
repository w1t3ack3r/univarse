import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config/config.js';
import { FileScanWorker } from './modules/files/file-scan.worker.js';
import { KeyMaintenance } from './shared/crypto/key-maintenance.js';
import { OutboxWorker } from './shared/outbox/outbox-worker.js';
import { WorkerModule } from './worker.module.js';

// Local dev convenience: repo-root .env. In deployed environments, env comes from the secret manager.
const rootEnv = new URL('../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig();
const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: ['error', 'warn', 'log'] });
const worker = ctx.get(OutboxWorker);
worker.start(config.WORKER_POLL_MS);
// Separate loop: a long key sweep never delays email.
const keys = ctx.get(KeyMaintenance);
keys.start(config.KEY_SWEEP_INTERVAL_MS);
// Separate loop again: a slow or unavailable scanner never delays email or the key sweep.
const scans = ctx.get(FileScanWorker);
scans.start(config.FILE_SCAN_INTERVAL_MS);
new Logger('Worker').log(`UniVarse worker polling the outbox every ${config.WORKER_POLL_MS} ms (${config.NODE_ENV})`);

const shutdown = async () => {
  await Promise.all([worker.stop(), keys.stop(), scans.stop()]);
  await ctx.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
