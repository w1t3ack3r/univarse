import { Injectable, Logger, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import type { ProductKey } from '@univarse/contracts';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../../shared/errors/problem.js';
import { NO_TENANT } from '../../shared/tenancy/tenant.guard.js';
import { ProductService } from './product.service.js';

export const PRODUCT = 'univarse:product';

/** Declares which product a tenant route belongs to (spec 0003 P2). Class or method. */
export const Product = (product: ProductKey) => SetMetadata(PRODUCT, product);

/** Indistinguishable from a route that doesn't exist (spec 0003 P3). */
const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

/**
 * Global guard between TenantGuard and AccessGuard: an inactive product's routes 404 before
 * authentication, so they leak nothing about the product to signed-in or anonymous callers.
 */
@Injectable()
export class ProductGuard implements CanActivate {
  private readonly logger = new Logger('Products');

  constructor(
    private readonly reflector: Reflector,
    private readonly products: ProductService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const product = this.reflector.getAllAndOverride<ProductKey | undefined>(PRODUCT, targets);
    if (!product) {
      // The boot check makes this unreachable; fail closed if it ever regresses.
      this.logger.error(`Route without product declaration: ${req.method} ${req.routeOptions.url}`);
      throw notFound();
    }
    if (!req.tenant || !(await this.products.isActive(req.tenant.tenantId, product))) throw notFound();
    return true;
  }
}

/**
 * Spec 0003 P2: lists `Controller.method` for every tenant route handler without a product.
 * Pure, so it is unit-testable; ProductDeclarationCheck runs it at boot over all controllers.
 */
export function findUndeclaredRoutes(controllers: readonly (new (...args: never[]) => unknown)[]): string[] {
  const missing: string[] = [];
  for (const controller of controllers) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue; // not a route
      const declared = (key: string): unknown => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
      if (declared(NO_TENANT) === true || declared(PRODUCT)) continue;
      missing.push(`${controller.name}.${name}`);
    }
  }
  return missing;
}
