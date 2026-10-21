// Spec 0019: `pnpm stack:down` stops the stack and keeps its volumes (data, Vault, configuration). It needs no
// verified record: stopping runs nothing new. It also removes a test tunnel a killed run may have left (B4).
import { spawnSync } from 'node:child_process';
import { COMPOSE_FILE, PROJECT, STACK_DIR } from './config.js';
import { removeTunnel } from './tunnel.js';

removeTunnel();
// The image variables are required by the compose file; stopping doesn't use them.
const placeholders = { UNIVARSE_API_IMAGE: 'none', UNIVARSE_WEB_IMAGE: 'none', UNIVARSE_MIGRATE_IMAGE: 'none', UNIVARSE_PGBOUNCER_IMAGE: 'none' };
const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'scan', '--profile', 'job', 'down'], {
  stdio: 'inherit',
  env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...placeholders },
});
process.exit(r.status ?? 1);
