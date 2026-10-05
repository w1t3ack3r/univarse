import type { NextConfig } from 'next';

// Served behind the edge (tools/dev-edge, production Caddy): /api/* never reaches this app (spec 0005 W2).
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@univarse/ui'],
};

export default config;
