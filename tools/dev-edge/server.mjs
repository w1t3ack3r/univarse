// Local stand-in for the production edge (Caddy / Gateway — docs/10 §3). DEV ONLY.
//   node tools/dev-edge/server.mjs      → http://demo-uni.univarse.localhost:4180
// Routes like the real edge (spec 0005 W2): /api/* and /health/* → API, everything else → web app.
// The browser only ever sees this origin, so API calls are same-origin.
// On both routes it:
//   * APPENDS the TCP peer to X-Forwarded-For (the API trusts only us and picks the right-most untrusted),
//   * OVERWRITES X-Forwarded-Host / -Proto (client values are never passed through).
// Run the API with TRUSTED_PROXIES=127.0.0.1 behind it (tools/dev-edge/start-api.mjs).
import http from 'node:http';

const PORT = Number(process.env.EDGE_PORT ?? 4180);
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 8099) };
const WEB = { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 3000) };
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  const toApi = url.startsWith('/api/') || url.startsWith('/health/');
  proxy(req, res, toApi ? API : WEB, toApi ? 'API' : 'web app');
});

function proxy(req, res, target, name) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !k.startsWith('x-forwarded-')) headers[k] = v;
  const prior = req.headers['x-forwarded-for'];
  const peer = req.socket.remoteAddress ?? 'unknown';
  headers['x-forwarded-for'] = prior ? `${prior}, ${peer}` : peer;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = 'http';

  const upstream = http.request({ ...target, method: req.method, path: req.url, headers }, (up) => {
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${name} unreachable on :${target.port}`);
  });
  req.pipe(upstream);
}

server.listen(PORT, '127.0.0.1', () =>
  console.log(`dev-edge on http://demo-uni.univarse.localhost:${PORT} → API :${API.port}, web :${WEB.port}`),
);
