// Spec 0028 Q5, Q14: the owner's command. On the stack, a one-shot job from the verified API image with the platform
// API's settings only (`pnpm stack:console owner …`); in development, against .env.console (`pnpm console:owner …`).
//   node dist/cli/platform-owner.js --email <address> --name "<name>"
//   node dist/cli/platform-owner.js --recover --email <address>
// It prints no secret: the activation code goes by email, through the console's outbox.
import { existsSync } from 'node:fs';
import { createPlatformClient } from '@univarse/db';
import { consoleKeyProvider, loadPlatformConfig } from '../platform/platform-config.js';
import { PlatformCredentials } from '../platform/identity/credentials.js';
import { createFirstOwner, recoverOwner } from '../platform/identity/owner.js';

const consoleEnv = new URL('../../../../.env.console', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(consoleEnv)) process.loadEnvFile(consoleEnv);

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const recover = args.includes('--recover');
const email = arg('email');
const name = arg('name');
if (!email || (!recover && !name)) {
  console.error('usage: platform-owner --email <address> --name "<name>"   |   platform-owner --recover --email <address>');
  process.exit(2);
}

const config = loadPlatformConfig();
const db = createPlatformClient(config.CONSOLE_DATABASE_URL);
try {
  const creds = new PlatformCredentials(config, consoleKeyProvider(config));
  const outcome = recover ? await recoverOwner(db, creds, email) : await createFirstOwner(db, creds, { email, displayName: name ?? '' });
  if (!outcome.ok) {
    console.error(`[console:owner] REFUSED ${outcome.problem}`);
    process.exitCode = 1;
  } else {
    // The member's id only, never the address (invariant 8: no personal data in logs).
    console.log(`[console:owner] ${recover ? 'recovered' : 'created'} the OWNER ${outcome.memberId}: the activation code is on its way to the address given (15 minutes)`);
  }
} finally {
  await db.$disconnect();
}
