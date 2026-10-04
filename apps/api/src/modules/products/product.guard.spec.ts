import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProductKey } from '@univarse/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../../shared/errors/problem.js';
import { NoTenant } from '../../shared/tenancy/tenant.guard.js';
import { HealthController } from '../health/health.controller.js';
import { AuthController } from '../identity/auth.controller.js';
import { MfaController } from '../identity/mfa.controller.js';
import { UsersController } from '../identity/users.controller.js';
import { TenantProfileController } from '../tenant-profile/tenant-profile.controller.js';
import { ProductDeclarationCheck } from './product-declaration.check.js';
import { findUndeclaredRoutes, Product, ProductGuard } from './product.guard.js';
import type { ProductService } from './product.service.js';
import { ProductsController } from './products.controller.js';

@Controller('x')
@Product('admissions')
class ClassLevel {
  @Get('a') a() {}
}

@Controller('y')
class MethodLevel {
  @Get('b') @Product('bursary') b() {}
  @Get('c') c() {}
  helper() {} // not a route: ignored
}

@Controller('z')
@NoTenant()
class Platform {
  @Get('d') d() {}
}

describe('[P2] every tenant route declares a product', () => {
  it('flags only tenant routes without @Product(), accepting class- or method-level declarations', () => {
    expect(findUndeclaredRoutes([ClassLevel, MethodLevel, Platform])).toEqual(['MethodLevel.c']);
  });

  it('holds for every controller in the app', () => {
    const all = [HealthController, TenantProfileController, AuthController, MfaController, UsersController, ProductsController];
    expect(findUndeclaredRoutes(all)).toEqual([]);
  });

  it('refuses to boot when a route is undeclared', () => {
    const discovery = { getControllers: () => [{ metatype: ClassLevel }, { metatype: MethodLevel }] };
    const check = new ProductDeclarationCheck(discovery as never);
    expect(() => check.onModuleInit()).toThrow(/MethodLevel\.c/);
  });
});

/** Route shapes the guard must handle. Only the metadata matters. */
class Routes {
  @Product('admissions') admissions() {}
  @Product('core') core() {}
  @NoTenant() platform() {}
  undeclared() {}
}

function run(handler: keyof Routes, active: readonly ProductKey[], tenant: { tenantId: string } | null = { tenantId: 't1' }) {
  const isActive = vi.fn(async (_t: string, p: ProductKey) => p === 'core' || active.includes(p));
  const guard = new ProductGuard(new Reflector(), { isActive } as unknown as ProductService);
  const req = { tenant: tenant ?? undefined, method: 'GET', routeOptions: { url: '/x' } };
  const ctx = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  return { result: guard.canActivate(ctx as never), isActive };
}

const notFound = expect.objectContaining({ status: 404, code: 'resource.not_found' }) as ProblemError;

describe('[P3] inactive product ⇒ 404 before authentication', () => {
  it('404s a route of an inactive (non-core) product', async () => {
    await expect(run('admissions', []).result).rejects.toEqual(notFound);
  });

  it('allows the route once the product is active, checking the request tenant', async () => {
    const { result, isActive } = run('admissions', ['admissions']);
    await expect(result).resolves.toBe(true);
    expect(isActive).toHaveBeenCalledWith('t1', 'admissions');
  });

  it('always allows core routes', async () => {
    await expect(run('core', []).result).resolves.toBe(true);
  });

  it('skips @NoTenant() routes', async () => {
    const { result, isActive } = run('platform', [], null);
    await expect(result).resolves.toBe(true);
    expect(isActive).not.toHaveBeenCalled();
  });

  it('fails closed (404) for an undeclared route or a missing tenant', async () => {
    await expect(run('undeclared', ['admissions']).result).rejects.toEqual(notFound);
    await expect(run('admissions', ['admissions'], null).result).rejects.toEqual(notFound);
  });
});

describe('[P3] guard order: tenant → product → access', () => {
  it('registers the global guards in that order', async () => {
    const { APP_GUARD } = await import('@nestjs/core');
    const { AppModule } = await import('../../app.module.js');
    const { TenantGuard } = await import('../../shared/tenancy/tenant.guard.js');
    const { AccessGuard } = await import('../identity/access.guard.js');
    const mod = AppModule.forRoot({} as never);
    const guards = (mod.providers ?? [])
      .filter((p) => typeof p === 'object' && 'provide' in p && p.provide === APP_GUARD)
      .map((p) => (p as { useClass: unknown }).useClass);
    expect(guards).toEqual([TenantGuard, ProductGuard, AccessGuard]);
  });
});
