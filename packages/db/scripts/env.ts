import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

/** Loads the repo-root .env (git-ignored) if present. Real env vars win. */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV_PATH)) process.loadEnvFile(ROOT_ENV_PATH);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Run \`pnpm db:setup\` first.`);
  return v;
}
