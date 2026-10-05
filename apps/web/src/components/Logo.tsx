import Image from 'next/image';

/**
 * Brand lockup (mark + wordmark), SVG from the brand kit (public/brand/). `deep` on light surfaces,
 * `lime` on deep green. Served as a static file, never inlined or optimised (SVG is not run through
 * the image optimiser).
 */
export function Logo({ tone, height = 32 }: { tone: 'deep' | 'lime'; height?: number }) {
  return (
    <Image
      src={`/brand/logo-${tone}.svg`}
      alt="UniVarse"
      width={Math.round((245 / 50) * height)}
      height={height}
      unoptimized
      priority
    />
  );
}
