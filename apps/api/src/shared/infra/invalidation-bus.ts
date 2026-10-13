// Spec 0015: the cross-instance invalidation bus for tenant-scoped caches (products, keys; the tenant resolver
// once it has a writer). The pattern of spec 0007's settings bus, as one helper:
//   • publish after commit, with a bounded attempt (the Valkey client never queues offline; an overall timeout),
//     never throwing. The result says what is KNOWN: how many subscriber connections received the message
//     (PUBLISH's count, not a confirmation that anything was evicted), or that delivery is unconfirmed;
//   • one dedicated subscriber connection per process, which never blocks startup and reconnects by itself;
//   • messages carry only a tenant id, zod-validated per message; channels are fixed constants (CI8).
// Valkey is trusted infrastructure (spec 0007). A forged message can only cause an extra eviction.
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { VALKEY } from './rate-limiter.js';

export const CHANNELS = Object.freeze({
  products: 'uv:products:invalidate',
  keysForget: 'uv:keys:forget',
  tenants: 'uv:tenants:invalidate',
} as const);
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

const Message = z.object({ tenantId: z.uuid() }).strict();

/** CI6: the bound on one publish attempt. */
export const PUBLISH_TIMEOUT_MS = 5_000;

export type PublishResult =
  | { readonly delivered: true; readonly receivers: number }
  | { readonly delivered: false; readonly reason: string };

/** The `keys` CLI publishes but must never subscribe (spec 0015 Design). */
export const BUS_SUBSCRIBE = Symbol('BUS_SUBSCRIBE');

@Injectable()
export class InvalidationBus implements OnModuleDestroy {
  private readonly logger = new Logger('InvalidationBus');
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<Channel, ((tenantId: string) => void)[]>();
  /** Messages received and handled, per channel (tests wait on it). */
  readonly received = new Map<Channel, number>();

  constructor(
    @Inject(VALKEY) private readonly publisher: Redis,
    @Inject(BUS_SUBSCRIBE) private readonly subscribeEnabled: boolean,
  ) {}

  /** After a committed change. Bounded (CI6) and never throws (CI4). */
  async publish(
    channel: Channel,
    tenantId: string,
    timeoutMs = PUBLISH_TIMEOUT_MS,
  ): Promise<PublishResult> {
    const body = JSON.stringify(Message.parse({ tenantId }));
    let timer: NodeJS.Timeout | undefined;
    try {
      const receivers = await Promise.race([
        this.publisher.publish(channel, body),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('publish timed out')), timeoutMs);
          timer.unref();
        }),
      ]);
      return { delivered: true, receivers };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'publish failed';
      this.logger.warn(
        {
          event: 'cache.invalidation.publish_failed',
          channel,
          tenantId,
          error: (err as Error).name,
        },
        'Invalidation not published; other instances converge within their TTL',
      );
      return { delivered: false, reason };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Registers a handler; the first registration opens the subscriber connection (never awaited at startup). */
  on(channel: Channel, handler: (tenantId: string) => void): void {
    if (!this.subscribeEnabled) return;
    const list = this.handlers.get(channel);
    if (list) {
      list.push(handler);
      return;
    }
    this.handlers.set(channel, [handler]);
    const sub = this.connection();
    sub
      .subscribe(channel)
      .catch((err: unknown) =>
        this.logger.warn(
          { event: 'cache.invalidation.subscribe_failed', channel, error: (err as Error).name },
          'Subscribe failed',
        ),
      );
  }

  /** Stops receiving (shutdown; tests simulate a lost message with it). */
  stopListening(): void {
    const sub = this.subscriber;
    this.subscriber = null;
    sub?.disconnect();
  }

  onModuleDestroy(): void {
    this.stopListening();
  }

  private connection(): Redis {
    if (this.subscriber) return this.subscriber;
    // A dedicated connection: a subscribed client can't run other commands. It reconnects and re-subscribes by
    // itself; startup never waits on Valkey.
    const sub = this.publisher.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    sub.on('error', (err: Error) =>
      this.logger.warn(
        { event: 'cache.invalidation.subscriber_error', error: err.name },
        'Invalidation subscriber error',
      ),
    );
    sub.on('message', (channel: string, message: string) =>
      this.onMessage(channel as Channel, message),
    );
    this.subscriber = sub;
    return sub;
  }

  private onMessage(channel: Channel, message: string): void {
    const handlers = this.handlers.get(channel);
    if (!handlers) return;
    let parsed: z.infer<typeof Message>;
    try {
      parsed = Message.parse(JSON.parse(message));
    } catch {
      this.logger.warn(
        { event: 'cache.invalidation.malformed', channel },
        'Malformed invalidation ignored',
      );
      return;
    }
    for (const h of handlers) h(parsed.tenantId);
    this.received.set(channel, (this.received.get(channel) ?? 0) + 1);
  }
}
