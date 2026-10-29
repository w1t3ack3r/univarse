// The dev edge passes WebSocket upgrades to the Next.js apps only (their dev runtime needs /_next/hmr to hydrate).
// Runs the real server.mjs against fake upstreams. `node --test tools/dev-edge/upgrade.test.mjs`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((done) => s.close(done));
  return port;
}

/** An upstream that completes any upgrade, records its request headers, and echoes what it receives. */
function upstream(seen) {
  const s = http.createServer((_req, res) => res.end('plain'));
  s.on('upgrade', (req, socket) => {
    seen.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n');
    socket.pipe(socket);
  });
  return s;
}

/** Sends an upgrade request through the edge; resolves with the status line and, on 101, the echo of `payload`. */
function upgrade(port, host, path, extra = '') {
  return new Promise((done, fail) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}\r\n`),
    );
    let got = '';
    socket.on('data', (chunk) => {
      got += chunk.toString();
      if (got.includes('\r\n\r\n') && !got.includes('ping')) {
        if (got.startsWith('HTTP/1.1 101')) socket.write('ping');
        else socket.end();
      }
      if (got.includes('ping')) socket.end();
    });
    socket.on('close', () => done({ status: got.split('\r\n')[0], echoed: got.endsWith('ping') }));
    socket.on('error', fail);
    setTimeout(() => socket.destroy(new Error(`no answer: ${JSON.stringify(got)}`)), 5000).unref();
  });
}

const web = [];
const console_ = [];
const api = [];
const servers = [upstream(web), upstream(console_), upstream(api), upstream([])];
let edgePort;
let edge;

before(async () => {
  const [webPort, consolePort, apiPort, platformPort] = await Promise.all(servers.map(listen));
  edgePort = await freePort();
  edge = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, EDGE_PORT: String(edgePort), WEB_PORT: String(webPort), CONSOLE_PORT: String(consolePort), API_PORT: String(apiPort), PLATFORM_API_PORT: String(platformPort) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((done) => edge.stdout.once('data', done));
});

after(() => {
  edge.kill();
  for (const s of servers) s.close();
});

test('the tenant web app and the console get their WebSocket, both ways', async () => {
  assert.deepEqual(await upgrade(edgePort, 'demo-uni.univarse.localhost:4180', '/_next/hmr'), { status: 'HTTP/1.1 101 Switching Protocols', echoed: true });
  assert.deepEqual(await upgrade(edgePort, 'console.univarse.localhost:4180', '/_next/hmr'), { status: 'HTTP/1.1 101 Switching Protocols', echoed: true });
  assert.equal(web.length, 1);
  assert.equal(console_.length, 1);
});

test('the edge sets the forwarding headers on an upgrade, never the client', async () => {
  web.length = 0;
  await upgrade(edgePort, 'demo-uni.univarse.localhost:4180', '/_next/hmr', 'X-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: https\r\n');
  assert.equal(web[0]['x-forwarded-host'], 'demo-uni.univarse.localhost:4180');
  assert.equal(web[0]['x-forwarded-proto'], 'http');
  assert.equal(web[0]['x-forwarded-for'], '127.0.0.1');
});

test('the APIs never upgrade, and a refused path stays refused', async () => {
  assert.deepEqual(await upgrade(edgePort, 'demo-uni.univarse.localhost:4180', '/api/v1/auth/me'), { status: 'HTTP/1.1 404 Not Found', echoed: false });
  assert.deepEqual(await upgrade(edgePort, 'console.univarse.localhost:4180', '/api/platform/v1/x'), { status: 'HTTP/1.1 404 Not Found', echoed: false });
  assert.deepEqual(await upgrade(edgePort, 'demo-uni.univarse.localhost:4180', '/api/platform/v1/x'), { status: 'HTTP/1.1 404 Not Found', echoed: false });
  assert.equal(api.length, 0);
});
