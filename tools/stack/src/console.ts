// Spec 0028 Q5, Q14: the console's owner, on the stack. One run of the `console-owner` job (compose.yml) from the
// deployed, verified API image, with the platform API's settings only:
//   pnpm stack:console owner --email <address> --name "<name>"     the first OWNER; refused if one exists
//   pnpm stack:console owner --recover --email <address>          an OWNER who lost both factors: a new activation code
// The activation code goes by email (Mailpit, https://mail.<stack domain>); nothing secret is printed.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { COMPOSE_FILE, PROJECT, STACK_DIR } from './config.js';
import { deployedImages } from './ledger/job.js';

export const USAGE = [
  'usage: pnpm stack:console owner --email <address> --name "<name>"',
  '       pnpm stack:console owner --recover --email <address>',
].join('\n');

/** The owner's command line, checked here so a mistake never starts a container. Returns the CLI's arguments. */
export function ownerArgs(argv: readonly string[]): string[] {
  const [command, ...rest] = argv;
  if (command !== 'owner') throw new Error(USAGE);
  const recover = rest.includes('--recover');
  const flags = rest.filter((a) => a !== '--recover');
  const values: Record<string, string> = {};
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i]?.replace(/^--/, '') ?? '';
    const value = flags[i + 1];
    if (!flags[i]?.startsWith('--') || !['email', 'name'].includes(name) || value === undefined || value.startsWith('--') || name in values) throw new Error(USAGE);
    values[name] = value;
  }
  const { email, name } = values;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(USAGE);
  if (recover ? name !== undefined : !name?.trim()) throw new Error(USAGE);
  return recover ? ['--recover', '--email', email] : ['--email', email, '--name', name ?? ''];
}

/** The job, its output passed straight through (the CLI prints the member's id, never the address). */
export function runOwnerJob(args: readonly string[], images: Readonly<Record<string, string>> = deployedImages()): number {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', 'console-owner', '--enable-source-maps', 'dist/cli/platform-owner.js', ...args], {
    stdio: 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
  });
  return r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args: string[];
  try {
    args = ownerArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  process.exit(runOwnerJob(args));
}
