import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Served behind the edge (tools/dev-edge, production Caddy): /api/* never reaches this app (spec 0005 W2).
const config: NextConfig = {
  // Spec 0013 CS2: the image build (infra/docker/web.Dockerfile) sets NEXT_STANDALONE=1 for a self-contained
  // server, traced from the repo root so workspace packages are included. Without it, `next dev` and the
  // `next start` used by source-mode E2E are unchanged (`next start` refuses standalone output).
  ...(process.env.NEXT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) }
    : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@univarse/ui'],
};

export default config;
