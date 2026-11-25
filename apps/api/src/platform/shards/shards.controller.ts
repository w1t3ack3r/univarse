// Spec 0039 Q12: the Shards page's one route, `platform.shard.read` (OWNER and SUPER_ADMIN). Reading only: making,
// migrating and retiring shards stay the owner's host command (`pnpm stack:shards`, spec 0036 T4).
import { Controller, Get } from '@nestjs/common';
import { RequirePlatformPermission } from '../identity/access.js';
import { PlatformShardsView } from './shards.service.js';

@Controller('api/platform/v1/shards')
export class PlatformShardsController {
  constructor(private readonly shards: PlatformShardsView) {}

  @Get()
  @RequirePlatformPermission('platform.shard.read')
  read() {
    return this.shards.read();
  }
}
