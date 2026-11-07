// Spec 0031 Q9: the API's and the worker's security counts, through their own platform client.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import type { Service } from '../observability/logger.js';
import { SECURITY_ROLLUP_SOURCE, SecurityRollupWriter } from '../observability/security-rollup.js';
import { PLATFORM_DB } from './db.module.js';

@Injectable()
export class TenantSideRollupWriter extends SecurityRollupWriter {
  constructor(@Inject(PLATFORM_DB) db: PlatformClient, @Inject(SECURITY_ROLLUP_SOURCE) source: Service | null) {
    super(db, source);
  }
}
