// Spec 0010 FU3/FU16: clamd over TCP (INSTREAM). Only an explicit "stream: OK" is clean; an ordinary
// "<signature> FOUND" is infected (whatever the signature: there is no test-specific logic here);
// anything else (timeouts, refusals, size-limit errors, odd replies) is a failure to scan.
import { connect } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export type ScanVerdict = { verdict: 'clean' } | { verdict: 'infected'; signature: string };

/** The scanner could not decide. Never maps to clean (FU3). `detail` is for logs only. */
export class ScannerUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`Scanner unavailable (${detail})`);
    this.name = 'ScannerUnavailable';
  }
}

const CHUNK = 64 * 1024;

/** Parses one clamd INSTREAM reply. Exported for unit tests. */
export function parseClamdReply(raw: string): ScanVerdict {
  const reply = raw.replace(/\0/g, '').trim();
  if (reply === 'stream: OK') return { verdict: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found?.[1]) return { verdict: 'infected', signature: found[1] };
  // Includes "INSTREAM size limit exceeded. ERROR" and every other reply.
  throw new ScannerUnavailable(reply.length > 0 ? `unexpected reply: ${reply.slice(0, 120)}` : 'empty reply');
}

@Injectable()
export class ClamdScanner {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  scan(bytes: Buffer): Promise<ScanVerdict> {
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = connect({ host: this.config.CLAMD_HOST, port: this.config.CLAMD_PORT });
      let reply = '';
      let settled = false;
      const fail = (detail: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailable(detail));
      };
      socket.setTimeout(this.config.CLAMD_TIMEOUT_MS, () => fail('timeout'));
      socket.on('error', (err: NodeJS.ErrnoException) => fail(err.code ?? err.name));
      socket.on('data', (d: Buffer) => (reply += d.toString('utf8')));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(parseClamdReply(reply));
        } catch (err) {
          reject(err instanceof Error ? err : new ScannerUnavailable('parse'));
        }
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < bytes.length; off += CHUNK) {
          const part = bytes.subarray(off, off + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.end(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}
