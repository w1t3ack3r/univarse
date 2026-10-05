import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// The CSP nonce is per request (src/proxy.ts), so no page may be prerendered statically: a static page's
// scripts would carry no nonce and our own policy would block them (spec 0005 W8).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'UniVarse', template: '%s · UniVarse' },
  description: 'UniVarse — the operating platform for your institution.',
  icons: { icon: '/brand/icon-deep.svg' },
  referrer: 'no-referrer',
};

export const viewport: Viewport = { themeColor: '#485550', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <a className="uv-skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
