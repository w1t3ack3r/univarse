import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { findUndeclaredRoutes } from './product.guard.js';

/** Spec 0003 P2: the app refuses to boot while any tenant route lacks @Product(). */
@Injectable()
export class ProductDeclarationCheck implements OnModuleInit {
  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const controllers = this.discovery
      .getControllers()
      .map((w) => w.metatype)
      .filter((m): m is new (...args: never[]) => unknown => typeof m === 'function');
    const missing = findUndeclaredRoutes(controllers);
    if (missing.length > 0) {
      throw new Error(`Tenant routes without @Product() (spec 0003 P2): ${missing.join(', ')}`);
    }
  }
}
