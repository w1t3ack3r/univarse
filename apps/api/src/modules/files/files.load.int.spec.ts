/**
 * Spec 0010 FU12 — combined peak memory, MEASURED. Opt-in (it deliberately stresses the machine):
 *   MEASURE_FILES_STACK=1 pnpm --filter @univarse/api exec vitest run --config vitest.int.config.ts src/modules/files/files.load.int.spec.ts
 * While uploads are being scanned and clean files downloaded concurrently, clamd is told to RELOAD its
 * signatures (it briefly holds two databases). Records each container's peak memory (sampled every
 * second), container restarts, scan outcomes (incl. retries and SCAN_FAILED) and failed downloads.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, HOSTS, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { FileScanWorker } from './file-scan.worker.js';

const enabled = process.env.MEASURE_FILES_STACK === '1';
const CONTAINERS = ['univarse-dev-clamav-1', 'univarse-dev-seaweedfs-1', 'univarse-dev-vault-1', 'univarse-dev-valkey-1', 'univarse-dev-mailpit-1'];
let h: Harness;

const toMiB = (s: string) => {
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2]!.startsWith('G') ? n * 1024 : m[2]!.startsWith('K') ? n / 1024 : n;
};
const restarts = () =>
  Object.fromEntries(CONTAINERS.map((c) => [c, Number(execFileSync('docker', ['inspect', '-f', '{{.RestartCount}}', c], { encoding: 'utf8' }).trim())]));
const clamd = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    const s = connect(3310, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString()));
    s.on('end', () => resolve(out.replace(/\0/g, '').trim()));
    s.on('error', reject);
    s.end(`z${cmd}\0`);
  });

describe.skipIf(!enabled)('[FU12] combined peak memory under scans, downloads and a signature reload', () => {
  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it('[FU12] measures, and nothing restarts or fails', async () => {
    const worker = h.workerCtx.get(FileScanWorker);
    const demo = { id: h.tenants.demo, shardId: (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId };
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const login = await h.login(HOSTS.demo, u.username);
    const raw = login.headers['set-cookie'];
    const session = (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-uv_sid='))!;

    // Sample memory every second.
    const peak: Record<string, number> = {};
    const sampler = spawn('docker', ['stats', '--format', '{{.Name}} {{.MemUsage}}', ...CONTAINERS]);
    sampler.stdout.on('data', (d: Buffer) => {
      // eslint-disable-next-line no-control-regex -- stripping docker's terminal escape codes is the point
      for (const line of d.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
        const [name, usage] = [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)];
        if (name && CONTAINERS.includes(name)) peak[name] = Math.max(peak[name] ?? 0, toMiB(usage));
      }
    });
    let hostPeak = 0;
    const hostTimer = setInterval(() => (hostPeak = Math.max(hostPeak, process.memoryUsage().rss / 1024 / 1024)), 500);
    const before = restarts();

    // A batch of real uploads (up to 4.5 MB each), then: scan + download loop + RELOAD in the middle.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const size = i % 3 === 0 ? 4_500_000 : 200_000;
      const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(size), Buffer.from('\n%%EOF\n')]);
      const slot = (await h.call('POST', HOSTS.demo, '/api/v1/files/uploads', { cookie: session, body: { name: `load${String(i)}.pdf`, mime: 'application/pdf', sizeBytes: bytes.length } })).json() as {
        file: { id: string };
        upload: { url: string; fields: Record<string, string> };
      };
      const form = new FormData();
      for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'f');
      expect((await fetch(slot.upload.url, { method: 'POST', body: form })).status).toBe(204);
      await h.call('POST', HOSTS.demo, `/api/v1/files/${slot.file.id}/complete`, { cookie: session });
      ids.push(slot.file.id);
    }

    let downloads = 0;
    let failedDownloads = 0;
    const control = { stop: false };
    const downloader = (async () => {
      while (!control.stop) {
        for (const id of ids) {
          const r: InjectResult = await h.call('GET', HOSTS.demo, `/api/v1/files/${id}/content`, { cookie: session });
          if (r.statusCode === 200) downloads++;
          else if (r.statusCode !== 409) failedDownloads++; // 409 = not clean yet, expected while scanning
        }
      }
    })();

    const reloadAt = Date.now();
    const scanning = (async () => {
      for (let pass = 0; pass < 20; pass++) {
        if (pass === 1) process.stdout.write(`\n[FU12] RELOAD -> ${await clamd('RELOAD')}\n`);
        await worker.scanTenant(demo);
        const left = await h.shard.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${demo.id}, true)`;
          return tx.fileObject.count({ where: { id: { in: ids }, state: { in: ['UPLOADED', 'SCANNING'] } } });
        });
        if (left === 0) break;
      }
    })();
    await scanning;
    await new Promise((r) => setTimeout(r, 15_000)); // keep sampling through the reload and downloads
    control.stop = true;
    await downloader;
    clearInterval(hostTimer);
    sampler.kill();

    const rows = await h.shard.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${demo.id}, true)`;
      return tx.fileObject.findMany({ where: { id: { in: ids } }, select: { state: true, scanAttempts: true } });
    });
    const outcome = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
    const retries = rows.reduce((n, r) => n + Math.max(0, r.scanAttempts - 1), 0);
    const after = restarts();
    const total = Object.values(peak).reduce((a, b) => a + b, 0);
    const report = {
      peakMiB: Object.fromEntries(Object.entries(peak).map(([k, v]) => [k.replace('univarse-dev-', '').replace('-1', ''), Math.round(v)])),
      peakSumContainersMiB: Math.round(total),
      hostProcessPeakMiB: Math.round(hostPeak),
      restarts: Object.fromEntries(CONTAINERS.map((c) => [c.replace('univarse-dev-', '').replace('-1', ''), after[c]! - before[c]!])),
      outcome,
      retries,
      downloads,
      failedDownloads,
      seconds: Math.round((Date.now() - reloadAt) / 1000),
    };
    process.stdout.write(`\n[FU12] ${JSON.stringify(report)}\n`);
    expect(Object.values(report.restarts).every((n) => n === 0)).toBe(true);
    expect(outcome.CLEAN).toBe(ids.length);
    expect(outcome.SCAN_FAILED ?? 0).toBe(0);
    expect(failedDownloads).toBe(0);
  }, 300_000);
});
