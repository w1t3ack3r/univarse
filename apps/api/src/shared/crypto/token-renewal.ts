// Spec 0023 T2: the API and the worker keep their own Vault token alive: renewed at start, then every 6 hours
// (`VaultTokenRenewer`). Only with the `vault` provider. A failure is logged, never thrown, and never changes
// readiness: Transit fails closed by itself (spec 0006 E6). The keys CLI, which reuses the worker's module, doesn't
// renew (it lives seconds; the deploy renews the token anyway).
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { VaultTokenRenewer } from '@univarse/crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export const RENEW_VAULT_TOKEN = Symbol('RENEW_VAULT_TOKEN');

@Injectable()
export class VaultTokenRenewal implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('VaultToken');
  private renewer: VaultTokenRenewer | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RENEW_VAULT_TOKEN) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const { KEY_PROVIDER, VAULT_ADDR, VAULT_TOKEN } = this.config;
    if (!this.enabled || KEY_PROVIDER !== 'vault' || !VAULT_ADDR || !VAULT_TOKEN) return;
    this.renewer = new VaultTokenRenewer({
      addr: VAULT_ADDR,
      token: VAULT_TOKEN,
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
