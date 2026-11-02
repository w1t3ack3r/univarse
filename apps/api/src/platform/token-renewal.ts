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
  private renewer: VaultTokenRenewer | null = null;

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(RENEW_CONSOLE_TOKEN) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const { CONSOLE_KEY_PROVIDER, VAULT_ADDR, CONSOLE_VAULT_TOKEN } = this.config;
    if (!this.enabled || CONSOLE_KEY_PROVIDER !== 'vault' || !VAULT_ADDR || !CONSOLE_VAULT_TOKEN) return;
    this.renewer = new VaultTokenRenewer({
      addr: VAULT_ADDR,
      token: CONSOLE_VAULT_TOKEN,
      log: {
        info: (name, fields, msg) => this.logger.log({ event: name, ...fields }, msg),
        warn: (name, fields, msg) => this.logger.warn({ event: name, ...fields }, msg),
        error: (name, fields, msg) => this.logger.error({ event: name, ...fields }, msg),
      },
    });
    this.renewer.start();
  }

  onApplicationShutdown(): void {
    this.renewer?.stop();
    this.renewer = null;
  }
}
