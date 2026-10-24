// Spec 0019 D7: the migrate job verifies PostgreSQL's certificate on every connection. Its URLs use libpq's form,
// `sslmode=verify-full&sslrootcert=<CA file>`, which node-postgres honours (bootstrap, rls:check, the seed, the keys).
// Prisma's schema engine (`migrate deploy` and `migrate status`) reads the same URLs its own way. Measured against a
// TLS endpoint (spec 0019's notes): it ignores `verify-full`, and `require`, with or without `sslcert`, encrypts
// without checking the certificate. It checks the chain and the host name only with
// `sslmode=require&sslcert=<CA file>&sslaccept=strict`, so that is what the Prisma configs give it.

/** True when node-postgres verifies this URL's server: `sslmode=verify-full` with the CA named in `sslrootcert`. */
export function verifiesServer(url: string): boolean {
  try {
    const q = new URL(url).searchParams;
    return q.get('sslmode') === 'verify-full' && !!q.get('sslrootcert');
  } catch {
    return false;
  }
}

/**
 * The URL in `env[name]` as Prisma's schema engine must read it to verify the server. A URL with no TLS settings
 * passes unchanged (the image's smoke, against a disposable plaintext database; production refuses one before this
 * runs). Anything else that wouldn't verify throws, naming the variable, never the URL (it holds a password).
 */
export function schemaEngineUrl(name: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const url = env[name];
  if (url === undefined) return undefined;
  const u = new URL(url);
  const q = u.searchParams;
  if (!q.has('sslmode') && !q.has('sslrootcert')) return url;
  const ca = q.get('sslrootcert');
  if (q.get('sslmode') !== 'verify-full' || !ca) throw new Error(`${name}: the migrate job needs sslmode=verify-full with sslrootcert, so Prisma's schema engine can verify the server`);
  q.delete('sslrootcert');
  q.set('sslmode', 'require');
  q.set('sslcert', ca);
  q.set('sslaccept', 'strict');
  return u.toString();
}
