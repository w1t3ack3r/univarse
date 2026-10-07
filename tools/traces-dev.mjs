// Spec 0012 D2/OB12: starts the local OpenTelemetry Collector (and, with `jaeger`, Jaeger's UI).
//   node tools/traces-dev.mjs           → collector only; spans land in infra/compose/otel/out/traces.jsonl
//   node tools/traces-dev.mjs jaeger    → also Jaeger on http://127.0.0.1:16686
// Then run the API and worker with OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';

const out = new URL('../infra/compose/otel/out/', import.meta.url);
mkdirSync(out, { recursive: true });
// The collector image runs as uid 10001; on Linux a host-owned bind mount needs to be writable by it.
// Local trace output only, git-ignored, never deployed.
chmodSync(out, 0o777);

const jaeger = process.argv.includes('jaeger');
const env = { ...process.env, ...(jaeger ? { OTEL_COLLECTOR_CONFIG: 'collector-jaeger.yaml' } : {}) };
// compose interpolates every service; CI has no .env-provided Valkey password, so give it a placeholder.
env.VALKEY_PASSWORD ??= 'traces-compose-interpolation-only';
const args = ['compose', '-f', 'infra/compose/compose.dev.yml'];
if (existsSync(new URL('../.env', import.meta.url))) args.push('--env-file', '.env');
args.push('--profile', 'traces', ...(jaeger ? ['--profile', 'jaeger'] : []), 'up', '-d', '--wait', 'otel-collector', ...(jaeger ? ['jaeger'] : []));
execFileSync('docker', args, { stdio: 'inherit', env, cwd: new URL('..', import.meta.url) });
console.log(`Collector up: OTLP/HTTP on http://127.0.0.1:14318, output in infra/compose/otel/out/traces.jsonl${jaeger ? '; Jaeger UI on http://127.0.0.1:16686' : ''}`);
