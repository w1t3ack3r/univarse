/**
 * A session's browser, in words a person recognises ("Chrome on Windows"), from its user agent. Order matters: Edge
 * and Opera say "Chrome" too, and every iOS browser says "Safari". Unknown parts are said plainly, never guessed.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

const TIME = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

/** A timestamp as staff read it, in their own time zone. */
export const when = (iso: string | null): string => (iso ? TIME.format(new Date(iso)) : 'Never');
