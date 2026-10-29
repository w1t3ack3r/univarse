import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { PlatformBar } from './platform-bar';
import './globals.css';

// The CSP nonce is per request (src/proxy.ts), so no page may be prerendered statically (as in the web app).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'UniVarse platform', template: '%s · UniVarse platform' },
  description: 'The UniVarse platform console, for UniVarse staff.',
  icons: { icon: '/brand/icon-deep.svg' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#485550', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <a className="uv-skip-link" href="#main">
          Skip to content
        </a>
        <PlatformBar />
        <main id="main" className="pc-main">
          {children}
        </main>
      </body>
    </html>
  );
}
