// Spec 0028 Q3, as spec 0023 T2 for the API and worker: the platform API keeps its own Vault token (the console key's)
// alive: renewed at start, then every 6 hours. Only the real process (platform.ts) asks for it, and only with the vault
// provider. A failure is logged, never thrown, and never changes readiness: Transit fails closed by itself.
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { VaultTokenRenewer } from '@univarse/crypto';
import { PLATFORM_CONFIG, type PlatformConfig } from './platform-config.js';

export const RENEW_CONSOLE_TOKEN = Symbol('RENEW_CONSOLE_TOKEN');

@Injectable()
export class ConsoleTokenRenewal implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('VaultToken');
  private renewers: VaultTokenRenewer[] = [];

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(RENEW_CONSOLE_TOKEN) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const { CONSOLE_KEY_PROVIDER, VAULT_ADDR, CONSOLE_VAULT_TOKEN, PROVISIONING_KEY_PROVIDER, PROVISIONING_VAULT_TOKEN } = this.config;
    if (!this.enabled || !VAULT_ADDR) return;
    const tokens = [
      ...(CONSOLE_KEY_PROVIDER === 'vault' && CONSOLE_VAULT_TOKEN ? [CONSOLE_VAULT_TOKEN] : []),
      // Spec 0034 Q7: the platform API's own provisioning token (encrypt only), kept alive the same way.
      ...(PROVISIONING_KEY_PROVIDER === 'vault' && PROVISIONING_VAULT_TOKEN ? [PROVISIONING_VAULT_TOKEN] : []),
    ];
    this.renewers = tokens.map(
      (token) =>
        new VaultTokenRenewer({
          addr: VAULT_ADDR,
          token,
          log: {
            info: (name, fields, msg) => this.logger.log({ event: name, ...fields }, msg),
            warn: (name, fields, msg) => this.logger.warn({ event: name, ...fields }, msg),
            error: (name, fields, msg) => this.logger.error({ event: name, ...fields }, msg),
          },
        }),
    );
    for (const r of this.renewers) r.start();
  }

  onApplicationShutdown(): void {
    for (const r of this.renewers) r.stop();
    this.renewers = [];
  }
}
