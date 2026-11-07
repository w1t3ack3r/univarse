// Spec 0031 Q9: the platform API's security counts, through the console role's client.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import type { Service } from '../../shared/observability/logger.js';
import { SECURITY_ROLLUP_SOURCE, SecurityRollupWriter } from '../../shared/observability/security-rollup.js';
import { CONSOLE_DB } from '../platform-config.js';

@Injectable()
export class ConsoleRollupWriter extends SecurityRollupWriter {
  constructor(@Inject(CONSOLE_DB) db: PlatformClient, @Inject(SECURITY_ROLLUP_SOURCE) source: Service | null) {
    super(db, source);
  }
}
