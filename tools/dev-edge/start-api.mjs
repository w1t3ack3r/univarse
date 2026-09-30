// Starts the built API configured to sit behind the dev edge (DEV ONLY).
// Cross-platform alternative to `TRUSTED_PROXIES=127.0.0.1 PORT=8099 node …`.
process.env.PORT ??= '8099';
process.env.TRUSTED_PROXIES ??= '127.0.0.1';
await import('../../apps/api/dist/main.js');
