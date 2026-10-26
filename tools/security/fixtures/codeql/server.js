// Proof fixture (spec 0024 G8), never run: a request's query string reaches a shell. CodeQL must block
// (js/command-line-injection, security-extended).
const { exec } = require('node:child_process');
const http = require('node:http');

http
  .createServer((req, res) => {
    const cmd = new URL(req.url, 'http://localhost').searchParams.get('cmd');
    exec(cmd, (err, out) => res.end(err ? 'error' : out));
  })
  .listen(8080);
