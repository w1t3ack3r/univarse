// Envelope encryption wiring (spec 0006, ADR-023). One FieldCrypto per process: the KEK provider
// from config, the per-tenant DEK cache, and the legacy v1 key for reads during migration (E9).
import type { Provider } from '@nestjs/common';
import { FieldCrypto, TenantKeyring, keyProviderFrom, legacyKeyringFromEnv } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../db/db.module.js';

export const fieldCryptoProvider: Provider = {
  provide: FieldCrypto,
  inject: [APP_CONFIG, PLATFORM_DB],
  useFactory: (config: AppConfig, platform: PlatformClient) =>
    new FieldCrypto(
      new TenantKeyring(platform, keyProviderFrom(config), { ttlMs: config.DEK_CACHE_TTL_MS }),
      legacyKeyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY),
    ),
};
