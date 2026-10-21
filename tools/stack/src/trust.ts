// Spec 0019 B3: `pnpm stack:trust` shows the edge CA the owner may install, and how to install, check and remove it in
// the current user's root store. It changes nothing itself: installing a root is the owner's step. The CA can vouch only
// for stack.univarse.localhost and its subdomains (B2). Chrome and Edge use this store; Firefox keeps its own.
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { edgeDir } from './certs.js';
import { STACK_DIR } from './config.js';

export interface EdgeCa {
  readonly file: string;
  readonly subject: string;
  readonly validTo: string;
  readonly sha256: string;
  /** Windows' thumbprint (SHA-1), which certutil names a certificate by. */
  readonly thumbprint: string;
}

export function edgeCa(dir = STACK_DIR): EdgeCa {
  const file = join(edgeDir(dir), 'edge-ca.crt');
  if (!existsSync(file)) throw new Error(`no edge CA at ${file}: run pnpm stack:init`);
  const x = new X509Certificate(readFileSync(file));
  return { file, subject: x.subject, validTo: x.validTo, sha256: x.fingerprint256, thumbprint: x.fingerprint.replaceAll(':', '') };
}

/** Whether the current user's root store holds this CA (Windows; reading the store changes nothing). */
export function installedOnWindows(ca: EdgeCa): boolean {
  return spawnSync('certutil', ['-user', '-verifystore', 'Root', ca.thumbprint], { encoding: 'utf8' }).status === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ca = edgeCa();
  const win = process.platform === 'win32';
  console.log(`[stack:trust] the edge CA: ${ca.subject.replaceAll('\n', ', ')}`);
  console.log(`[stack:trust]   file:     ${ca.file}`);
  console.log(`[stack:trust]   SHA-256:  ${ca.sha256}`);
  console.log(`[stack:trust]   expires:  ${ca.validTo}`);
  console.log('[stack:trust] It can vouch only for stack.univarse.localhost and its subdomains (name constraint, B2).');
  if (!win) {
    console.log('[stack:trust] Install it in your OS or browser trust store by its own procedure; check the SHA-256 first.');
  } else {
    console.log(`[stack:trust] installed for this user: ${installedOnWindows(ca) ? 'yes' : 'no'}`);
    console.log('[stack:trust] Check the SHA-256 above against the file, then, in PowerShell (Windows asks you to confirm):');
    console.log(`  install: certutil -user -addstore Root "${ca.file}"`);
    console.log(`  check:   certutil -user -verifystore Root ${ca.thumbprint}`);
    console.log(`  remove:  certutil -user -delstore Root ${ca.thumbprint}`);
    console.log('[stack:trust] After `pnpm stack:init --rotate-edge`, remove the old one and install the new one.');
  }
}
