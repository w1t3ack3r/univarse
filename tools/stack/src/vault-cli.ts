// Spec 0019 D9 and spec 0020 B-4: `pnpm stack:vault status | init | unseal | migrate-raft <releases/record.json>`.
// The entry point lives here, apart from vault.ts, because vault-raft.ts and vault-raft-cli.ts import vault.ts: when
// vault.ts was itself the entry, its top-level await on the migration's module waited for a module that waited for
// vault.ts, and Node exited 13 ("unsettled top-level await") before anything ran. Nothing imports this file.
import { migrateRaftCli } from './vault-raft-cli.js';
import { initialise, unseal, vaultState } from './vault.js';

const USAGE = 'usage: pnpm stack:vault status | init | unseal | migrate-raft <releases/record.json>';

export function main(argv: readonly string[]): { ok: boolean; lines: string[] } {
  const [cmd, ...rest] = argv;
  if (cmd === 'migrate-raft') return migrateRaftCli(rest); // it checks Vault's state itself
  if (cmd !== 'status' && cmd !== 'unseal' && cmd !== 'init') return { ok: false, lines: [USAGE] };
  const state = vaultState();
  if (cmd === 'status') return { ok: true, lines: [state] };
  if (cmd === 'unseal') {
    if (state !== 'sealed') return { ok: true, lines: [`nothing to do: Vault is ${state}`] };
    unseal();
    return { ok: true, lines: [`unsealed: ${vaultState()}`] };
  }
  if (state !== 'uninitialised') return { ok: true, lines: [`nothing to do: Vault is ${state}`] };
  initialise();
  return { ok: true, lines: ['initialised and unsealed; the audit device, Transit, the KEK and the app token are ready (saved owner-only)'] };
}

let r: { ok: boolean; lines: string[] };
try {
  r = main(process.argv.slice(2));
} catch (e) {
  r = { ok: false, lines: [(e as Error).message] };
}
for (const l of r.lines) (r.ok ? console.log : console.error)(`[stack:vault] ${l}`);
process.exit(r.ok ? 0 : r.lines[0] === USAGE ? 2 : 1);
