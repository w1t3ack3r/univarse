// Spec 0020 D7, B-9: when the backup destination is an external drive, a ledger destination must be on that drive too,
// so the drive that survives the loss of this disk carries the ledger as well as the backups. "External" is decided
// from the file system, not from a flag the owner sets: a destination on a different device from the ledger's primary
// (Node's `stat().dev`: the device number, or on Windows the volume's serial number). A path that doesn't exist yet
// is judged by its nearest existing parent.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DevOf = (path: string) => bigint | null;

export const devOf: DevOf = (path) => {
  let p = resolve(path);
  for (;;) {
    try {
      return statSync(p, { bigint: true }).dev;
    } catch {
      const up = dirname(p);
      if (up === p) return null;
      p = up;
    }
  }
};

/**
 * Null when the rule holds. Otherwise why not, naming the command that fixes it. `ledgerDestinations` are the paths the
 * ledger's configuration (or a waiver's new generation) names, the primary among them.
 */
export function externalRuleProblem(backupDestination: string, primary: string, ledgerDestinations: readonly string[], dev: DevOf = devOf): string | null {
  const backup = dev(backupDestination);
  const home = dev(primary);
  if (backup === null) return `the backup destination ${backupDestination} can't be read: is the drive connected?`;
  if (home === null) return `the ledger's primary ${primary} can't be read`;
  if (backup === home) return null;
  if (ledgerDestinations.some((p) => dev(p) === backup)) return null;
  return `the backup destination ${backupDestination} is on another drive than the ledger's primary, so that drive must hold a ledger destination too (spec 0020 D7): \`pnpm stack:keys ledger add-destination <a folder on that drive>\``;
}
