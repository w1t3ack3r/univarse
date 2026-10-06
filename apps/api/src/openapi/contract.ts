// Spec 0011: binds a handler to its operation in packages/contracts. The generator refuses any route
// without one (OA2).
import { SetMetadata } from '@nestjs/common';
import type { ApiOperation } from '@univarse/contracts';

export const CONTRACT = 'univarse:contract';
export const Contract = (op: ApiOperation) => SetMetadata(CONTRACT, op);
