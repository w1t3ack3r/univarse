import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The platform console (spec 0027 P6), on its own host: /api/platform/* goes to the platform API, everything else here.
// The image build sets NEXT_STANDALONE=1, as for the web app (spec 0013 CS2).
const config: NextConfig = {
  ...(process.env.NEXT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) }
    : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@univarse/ui'],
};

export default config;
