// Local stand-in for the production edge (Caddy / Gateway — docs/10 §3). DEV ONLY.
//   node tools/dev-edge/server.mjs      → http://demo-uni.univarse.localhost:4180
// - Serves a tiny auth harness page (same origin as the API, like the real web app).
// - Proxies /api/* and /health/* to the API, behaving like our edge must:
//     * APPENDS the TCP peer to X-Forwarded-For (API trusts only us, picks the right-most untrusted),
//     * OVERWRITES X-Forwarded-Host / -Proto (client values are never passed through).
// Run the API with TRUSTED_PROXIES=127.0.0.1 behind it.
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.EDGE_PORT ?? 4180);
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 8099) };
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/') || url.startsWith('/health/')) return proxy(req, res);

  const file = normalize(join(PUBLIC, url === '/' ? 'index.html' : url.split('?')[0]));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !TYPES[extname(file)]) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)],
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

function proxy(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !k.startsWith('x-forwarded-')) headers[k] = v;
  const prior = req.headers['x-forwarded-for'];
  const peer = req.socket.remoteAddress ?? 'unknown';
  headers['x-forwarded-for'] = prior ? `${prior}, ${peer}` : peer;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = 'http';

  const upstream = http.request({ ...API, method: req.method, path: req.url, headers }, (up) => {
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502, { 'content-type': 'text/plain' }).end('API unreachable'));
  req.pipe(upstream);
}

server.listen(PORT, '127.0.0.1', () => console.log(`dev-edge on http://demo-uni.univarse.localhost:${PORT} → API :${API.port}`));
