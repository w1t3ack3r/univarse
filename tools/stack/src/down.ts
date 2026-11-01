// Spec 0019: `pnpm stack:down` stops the stack and keeps its volumes (data, Vault, configuration). It needs no
// verified record: stopping runs nothing new. It also removes a test tunnel a killed run may have left (B4), and the
// containers' anonymous volumes, which no later `up` would reach (downSteps).
import { spawnSync } from 'node:child_process';
import { COMPOSE_FILE, PROJECT, ROLE_VARS, STACK_DIR } from './config.js';
import { downSteps } from './docker.js';
import { removeTunnel } from './tunnel.js';

removeTunnel();
// The image variables are required by the compose file; stopping doesn't use them.
const placeholders = Object.fromEntries(Object.values(ROLE_VARS).map((v) => [v, 'none']));
let status = 0;
for (const step of downSteps()) {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'scan', '--profile', 'job', ...step], {
    stdio: 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...placeholders },
  });
  if (status === 0) status = r.status ?? 1;
}
process.exit(status);
