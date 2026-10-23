// Spec 0019 LS1 (the shape), LS2 (only digests), LS9 (no secret in the file) and LS10 (memory), on the compose file as compose itself resolves
// it (`docker compose config`: anchors merged, defaults applied), with the four image variables set to stand-in
// digests. Needs the Docker CLI (not a running stack).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envText } from './render.js';
import { CADDY_IP, COMPOSE_FILE, isDigestRef, MEMORY_BUDGET_MB, PROJECT, ROLE_VARS, THIRD_PARTY, WEB_IP } from './config.js';

interface Service {
  image: string;
  profiles?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  mem_limit?: string | number;
  user?: string;
  networks?: Record<string, unknown>;
  ports?: { host_ip?: string; published?: string; target: number }[];
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
  healthcheck?: { test?: string[] };
}
interface Config {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
}

const STAND_IN = Object.fromEntries(Object.entries(ROLE_VARS).map(([role, v], i) => [v, `localhost:5000/univarse-${role}@sha256:${String(i + 1).repeat(64)}`]));
let config: Config;
// compose checks that each env file exists; empty ones stand in (the content is render.spec's subject).
let stackDir: string;
beforeAll(() => {
  stackDir = mkdtempSync(join(tmpdir(), 'uv-stack-compose-'));
  for (const f of ['postgres.env', 'migrate.env', 'api.env', 'worker.env', 'web.env', 'keys.env']) writeFileSync(join(stackDir, f), '');
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'scan', '--profile', 'job', 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, UNIVARSE_STACK_DIR: stackDir, ...STAND_IN },
  });
  if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
  config = JSON.parse(r.stdout) as Config;
});
afterAll(() => rmSync(stackDir, { recursive: true, force: true }));

const svc = (name: string) => {
  const s = config.services[name];
  if (!s) throw new Error(`no ${name} service`);
  return s;
};
const UNIVARSE = ['pgbouncer', 'migrate', 'api', 'worker', 'web'];
/** compose resolves `512m` to bytes (a number, or a numeric string). */
const mb = (m: string | number | undefined) => Number(m) / 1024 / 1024;

describe('[LS1] the shape', () => {
  it('[LS1] only Caddy publishes ports, only on 127.0.0.1, and it is the only service on the edge network', () => {
    const publishing = Object.entries(config.services).filter(([, s]) => (s.ports ?? []).length > 0).map(([n]) => n);
    expect(publishing).toEqual(['caddy']);
    for (const p of svc('caddy').ports ?? []) expect(p.host_ip).toBe('127.0.0.1');
    const onEdge = Object.entries(config.services).filter(([, s]) => 'edge' in (s.networks ?? {})).map(([n]) => n);
    expect(onEdge).toEqual(['caddy']);
  });

  it('[LS1][LS7] Caddy publishes exactly HTTPS (443) and the redirect (80), and reads its certificate read-only', () => {
    const ports = (svc('caddy').ports ?? []).map((p) => `${p.host_ip ?? ''}:${String(p.published)}->${String(p.target)}`).sort();
    expect(ports).toEqual(['127.0.0.1:443->8443', '127.0.0.1:80->8080']);
    expect((svc('caddy').volumes ?? []).find((v) => v.target === '/etc/caddy/tls')).toMatchObject({ source: 'caddy-tls', read_only: true });
  });

  it('[LS1] the app and db networks are internal; PostgreSQL is on db only, shared with PgBouncer and the migrate job', () => {
    expect(config.networks.app?.internal).toBe(true);
    expect(config.networks.db?.internal).toBe(true);
    expect(Object.keys(svc('postgres').networks ?? {})).toEqual(['db']);
    const onDb = Object.entries(config.services).filter(([, s]) => 'db' in (s.networks ?? {})).map(([n]) => n).sort();
    expect(onDb).toEqual(['migrate', 'pgbouncer', 'postgres']);
    for (const s of ['api', 'worker', 'web']) expect(Object.keys(svc(s).networks ?? {})).toEqual(['app']);
  });

  it('[LS1] Caddy and the web app hold the fixed addresses the API trusts for forwarding headers', () => {
    const ip = (s: string) => (svc(s).networks?.app as { ipv4_address?: string } | null | undefined)?.ipv4_address;
    expect([ip('caddy'), ip('web')]).toEqual([CADDY_IP, WEB_IP]);
  });

  it('[LS1] every service is read-only (ClamAV excepted: freshclam writes its database), capability-free, no-new-privileges, memory-limited', () => {
    for (const [name, s] of Object.entries(config.services)) {
      if (name !== 'clamav') expect([name, s.read_only]).toEqual([name, true]);
      expect([name, s.cap_drop]).toEqual([name, ['ALL']]);
      expect([name, (s.security_opt ?? []).some((o) => o.startsWith('no-new-privileges'))]).toEqual([name, true]);
      expect([name, s.mem_limit !== undefined]).toEqual([name, true]);
    }
  });

  it("[LS1] capabilities are added only where stated: NET_BIND_SERVICE on Caddy (its binary's file capability), ClamAV's root-entrypoint set; none on a UniVarse service", () => {
    const added = Object.fromEntries(Object.entries(config.services).filter(([, s]) => (s.cap_add ?? []).length).map(([n, s]) => [n, [...(s.cap_add ?? [])].sort()]));
    expect(added).toEqual({ caddy: ['NET_BIND_SERVICE'], clamav: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'] });
  });

  it('[LS1] no service runs as root by configuration, and none mounts the Docker socket', () => {
    for (const [name, s] of Object.entries(config.services)) {
      if (s.user !== undefined) expect([name, s.user.startsWith('0')]).toEqual([name, false]);
      for (const v of s.volumes ?? []) expect([name, v.source ?? '']).not.toEqual([name, expect.stringContaining('docker.sock')]);
    }
  });
});

describe('[D9] Vault', () => {
  it('[D9] Vault has a healthcheck that passes once its listener answers, sealed or not, so `up --wait vault` means it can be read', () => {
    // Without one, `--wait` returned as soon as the container ran, and the deploy read an unanswering Vault as absent.
    const test = svc('vault').healthcheck?.test ?? [];
    expect(test[0]).toBe('CMD-SHELL');
    // `vault status`: 0 unsealed, 2 sealed (or uninitialised), 1 unreachable; only 1 is unhealthy.
    expect(test.slice(1).join(' ')).toMatch(/^vault status -address=https:\/\/127\.0\.0\.1:8200 .*\[ \$\$\? -ne 1 \]$/);
  });
});

describe('[LS2] only digests', () => {
  it('[LS2] every image is pinned by digest; the third-party pins are the trusted ones', () => {
    for (const [name, s] of Object.entries(config.services)) expect([name, isDigestRef(s.image)]).toEqual([name, true]);
    for (const [name, ref] of Object.entries(THIRD_PARTY)) expect([name, svc(name).image]).toEqual([name, ref]);
  });

  it('[LS2] the compose file names no UniVarse image: the four come from the deploy\'s variables', () => {
    expect(svc('api').image).toBe(STAND_IN.UNIVARSE_API_IMAGE);
    expect(svc('worker').image).toBe(STAND_IN.UNIVARSE_API_IMAGE);
    expect(svc('web').image).toBe(STAND_IN.UNIVARSE_WEB_IMAGE);
    expect(svc('migrate').image).toBe(STAND_IN.UNIVARSE_MIGRATE_IMAGE);
    expect(svc('pgbouncer').image).toBe(STAND_IN.UNIVARSE_PGBOUNCER_IMAGE);
  });

  it('[LS2] without the deploy\'s variables, compose refuses to start the stack', () => {
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'config'], { encoding: 'utf8', env: { ...process.env, UNIVARSE_STACK_DIR: stackDir } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pnpm stack:deploy sets the verified image/);
  });
});

describe('[LS8] Vault: TLS only, and its audit device on its own volume (C2, C3)', () => {
  it('[LS8] Vault reads its certificate read-only and writes its audit log to its own volume; its healthcheck verifies TLS', () => {
    const v = svc('vault') as Service & { healthcheck?: { test?: string[] } };
    expect((v.volumes ?? []).find((m) => m.target === '/vault/tls')).toMatchObject({ source: 'vault-tls', read_only: true });
    expect((v.volumes ?? []).find((m) => m.target === '/vault/logs')).toMatchObject({ source: 'vault-audit' });
    expect((v.healthcheck?.test ?? []).join(' ')).toMatch(/-address=https:\/\/127\.0\.0\.1:8200 -ca-cert=\/vault\/tls\/ca\.crt -tls-server-name=vault/);
  });

  it('[LS8] its listener has TLS on (1.2 at least) and no plaintext switch; its API address is https', () => {
    const hcl = readFileSync(join(COMPOSE_FILE, '..', 'vault', 'stack.hcl'), 'utf8').replace(/#.*$/gm, '');
    expect(hcl).not.toMatch(/tls_disable/);
    expect(hcl).toMatch(/tls_cert_file\s*=\s*"\/vault\/tls\/vault\.crt"/);
    expect(hcl).toMatch(/tls_key_file\s*=\s*"\/vault\/tls\/vault\.key"/);
    expect(hcl).toMatch(/tls_min_version\s*=\s*"tls12"/);
    expect(hcl).toMatch(/api_addr\s*=\s*"https:\/\/vault:8200"/);
  });
});

describe('[LS9] no secret in the compose file', () => {
  it('[LS9] with the env files empty, no service is given a secret-named variable, and the file holds no secret-shaped literal', () => {
    const secretName = /PASSWORD|SECRET|TOKEN|PEPPER|VERIFIER|ACCESS_KEY|_URL$/;
    for (const [name, s] of Object.entries(config.services as Record<string, { environment?: Record<string, string | null> }>))
      expect([name, Object.keys(s.environment ?? {}).filter((k) => secretName.test(k))]).toEqual([name, []]);
    // Image digests are the only long hex in the file; nothing base64-shaped at all.
    const text = readFileSync(COMPOSE_FILE, 'utf8').replace(/@sha256:[0-9a-f]{64}/g, '');
    // Generated secrets are hex, or base64url (30+ random bytes: digits and lower case); a long setting name is neither,
    // with no digit (CLAMD_CONF_AlertEncryptedArchive) or no lower case (WEED_MASTER_VOLUME_GROWTH_COPY_1).
    expect(text.match(/[0-9a-f]{24,}|(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []).toEqual([]);
  });
});

describe('[LS3] env files reach the containers exactly as written', () => {
  it('[LS3] a value full of `$` (a SCRAM verifier\'s shape) comes out of compose unchanged, with no variable warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-stack-env-'));
    try {
      // Not a real verifier: the same characters, in the same places.
      const value = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVkS2V5$c2VydmVyS2V5$$x${y}$';
      for (const f of ['postgres.env', 'api.env', 'worker.env', 'web.env', 'keys.env']) writeFileSync(join(dir, f), '');
      writeFileSync(join(dir, 'migrate.env'), envText({ ROLE_VERIFIER_PROBE: value }));
      const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'config', '--format', 'json', 'migrate'], {
        encoding: 'utf8',
        env: { ...process.env, UNIVARSE_STACK_DIR: dir, ...STAND_IN },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/variable is not set/);
      const env = (JSON.parse(r.stdout) as { services: Record<string, { environment?: Record<string, string> }> }).services.migrate?.environment ?? {};
      // `config` prints a compose file, so it writes each literal `$` back as `$$`: doubled means taken literally
      // (unescaped, `$c3RvcmVkS2V5` came out empty, with a warning naming it).
      expect(env.ROLE_VERIFIER_PROBE).toBe(value.replaceAll('$', '$$$$'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[LS10] memory', () => {
  it(`[LS10] the long-running services' limits, ClamAV and the one-shot migrate job excluded, sum to at most ${String(MEMORY_BUDGET_MB)} MB`, () => {
    const total = Object.entries(config.services)
      .filter(([n, s]) => !(s.profiles ?? []).length && n !== 'migrate')
      .reduce((sum, [, s]) => sum + mb(s.mem_limit), 0);
    expect(total).toBeLessThanOrEqual(MEMORY_BUDGET_MB);
  });

  it('[LS1] the UniVarse services carry the same hardening as the rest', () => {
    for (const name of UNIVARSE) expect(svc(name).read_only).toBe(true);
  });
});
