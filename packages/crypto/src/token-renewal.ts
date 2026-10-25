// Spec 0023 T2: the API and the worker renew their own Vault token. It is periodic (768 h on the stack): each
// renewal resets its TTL to the period, so the token lives as long as the services do. A failure is logged for
// humans (an integrity signal, never acted on), retried at the next tick, and never thrown into the app or reflected
// in readiness: Transit's own failures already fail closed (E6). Nothing logged is the token or a Vault response body.

export const RENEW_EVERY_MS = 6 * 3600 * 1000;

/** What one renewal came to. `refused` is Vault's "no" to this token (400 or 403): it is dead or revoked. */
export type RenewOutcome =
  | { readonly kind: 'renewed'; readonly ttlSeconds: number }
  | { readonly kind: 'sealed' }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'failed'; readonly detail: string };

/** Each line: a stable event name (spec 0012 OB2), its fields (never the token), and a message. */
export interface RenewerLog {
  info(event: string, fields: Record<string, unknown>, msg: string): void;
  warn(event: string, fields: Record<string, unknown>, msg: string): void;
  error(event: string, fields: Record<string, unknown>, msg: string): void;
}

export interface RenewerOptions {
  readonly addr: string;
  readonly token: string;
  readonly log: RenewerLog;
  readonly everyMs?: number;
  readonly timeoutMs?: number;
  /** Tests: a fake fetch and timers. */
  readonly fetch?: typeof fetch;
  readonly setInterval?: (f: () => void, ms: number) => { unref?: () => unknown };
  readonly clearInterval?: (t: unknown) => void;
}

export class VaultTokenRenewer {
  private timer: unknown = null;

  constructor(private readonly opts: RenewerOptions) {}

  /** `POST auth/token/renew-self` with no increment: back to the full period. Never throws. */
  async renewOnce(): Promise<RenewOutcome> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.addr.replace(/\/$/, '')}/v1/auth/token/renew-self`, {
        method: 'POST',
        headers: { 'x-vault-token': this.opts.token, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return { kind: 'failed', detail: e.cause?.code ?? e.name ?? 'network' };
    }
    if (res.status === 503) {
      await res.body?.cancel();
      return { kind: 'sealed' };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return res.status === 400 || res.status === 403 ? { kind: 'refused', status: res.status } : { kind: 'failed', detail: `HTTP ${String(res.status)}` };
    }
    try {
      const ttl = ((await res.json()) as { auth?: { lease_duration?: unknown } }).auth?.lease_duration;
      return typeof ttl === 'number' ? { kind: 'renewed', ttlSeconds: ttl } : { kind: 'failed', detail: 'no lease_duration' };
    } catch {
      return { kind: 'failed', detail: 'unreadable response' };
    }
  }

  /** One renewal, logged. */
  async tick(): Promise<RenewOutcome> {
    const o = await this.renewOnce();
    const log = this.opts.log;
    if (o.kind === 'renewed') log.info('vault.token.renewed', { ttlSeconds: o.ttlSeconds }, 'Vault token renewed');
    else if (o.kind === 'sealed') log.warn('vault.token.renew_failed', { reason: 'sealed' }, 'Vault is sealed: the token is not renewed until `pnpm stack:vault unseal`');
    else if (o.kind === 'refused')
      log.error('vault.token.renew_refused', { status: o.status }, 'Vault refused to renew this token: it is expired or revoked; `pnpm stack:deploy` re-issues it');
    else log.warn('vault.token.renew_failed', { reason: o.detail }, 'Vault token renewal failed; retried at the next tick');
    return o;
  }

  /** Renews now, then every `everyMs`. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    const every = this.opts.everyMs ?? RENEW_EVERY_MS;
    const t = (this.opts.setInterval ?? setInterval)(() => void this.tick(), every);
    t.unref?.();
    this.timer = t;
  }

  stop(): void {
    if (!this.timer) return;
    (this.opts.clearInterval ?? ((x: unknown) => clearInterval(x as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }
}
