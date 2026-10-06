// Spec 0009: the route sweep's machinery. Route capture (RS1) and the isolation checks as pure
// functions returning findings, so the negative controls can assert the exact leak (RS8).
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

export type AuthKind = 'none' | 'public' | 'mfa-challenge' | 'restricted-session' | 'session';
export type IsolationClass = 'public-auth' | 'self' | 'collection' | 'keyed' | 'resource';

export interface Finding {
  readonly route: string;
  readonly rule: 'RS1' | 'RS3' | 'RS4' | 'RS5' | 'RS6' | 'RS7';
  readonly location?: string;
  readonly marker?: string;
  readonly detail?: string;
}

/** `METHOD /path` with Nest/Fastify parameter syntax, e.g. `PUT /api/v1/settings/:key`. */
export type RouteKey = string;
export const routeKey = (method: string, url: string): RouteKey => `${method.toUpperCase()} ${url}`;

/** Attach before `app.init()`: records every route Fastify registers, as registered (RS1). */
export function captureRoutes(fastify: FastifyInstance, into: Set<RouteKey>): void {
  fastify.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const m of methods) into.add(routeKey(String(m), opts.url));
  });
}

/** The routes Nest declares, from controller metadata. */
export function nestRoutes(app: INestApplication): Set<RouteKey> {
  const out = new Set<RouteKey>();
  for (const wrapper of app.get(DiscoveryService).getControllers()) {
    const type = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
    if (!type) continue;
    const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
    const proto = type.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const url = '/' + [base, path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
      out.add(routeKey(method, url));
    }
  }
  return out;
}

/**
 * RS1: Fastify's registrations against Nest's declarations. The only framework additions allowed are
 * the HEAD twin of each GET (Fastify `exposeHeadRoutes`). Anything else is reported.
 */
export function crossCheckRoutes(fastify: ReadonlySet<RouteKey>, nest: ReadonlySet<RouteKey>): Finding[] {
  const findings: Finding[] = [];
  for (const r of fastify) {
    if (nest.has(r)) continue;
    const [method, url] = r.split(' ') as [string, string];
    if (method === 'HEAD' && nest.has(routeKey('GET', url))) continue;
    findings.push({ route: r, rule: 'RS1', detail: 'served by Fastify but not declared in Nest' });
  }
  for (const r of nest) if (!fastify.has(r)) findings.push({ route: r, rule: 'RS1', detail: 'declared in Nest but not served' });
  return findings;
}

/** Every string a response could carry a marker in. */
const textOf = (body: unknown): string => (typeof body === 'string' ? body : JSON.stringify(body ?? null));

/** RS4: A's markers present (non-vacuous), no B marker. */
export function checkCollection(route: RouteKey, body: unknown, aMarkers: readonly string[], bMarkers: readonly string[]): Finding[] {
  const text = textOf(body);
  const findings: Finding[] = [];
  for (const m of aMarkers) if (!text.includes(m)) findings.push({ route, rule: 'RS4', marker: m, detail: 'own marker missing (check would be vacuous)' });
  for (const m of bMarkers) if (text.includes(m)) findings.push({ route, rule: 'RS4', marker: m, detail: 'other tenant marker exposed' });
  return findings;
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** The documented error behaviour, minus per-request fields: status, problem code and body shape. */
const errorShape = (a: Answer) => {
  const b = (a.body ?? {}) as Record<string, unknown>;
  const { requestId: _r, ...rest } = b;
  return JSON.stringify({ status: a.status, code: b.code, keys: Object.keys(rest).sort(), title: b.title });
};

/**
 * RS6, per location: B's existing id must answer exactly like a nonexistent id (no existence oracle)
 * and must never carry B's marker. `own` is the baseline on A's own record and must succeed.
 */
export function checkResource(
  route: RouteKey,
  location: string,
  answers: { own: Answer; otherTenant: Answer; missing: Answer },
  bMarker: string,
): Finding[] {
  const findings: Finding[] = [];
  if (answers.own.status !== 200) findings.push({ route, rule: 'RS6', location, detail: `baseline on own record answered ${String(answers.own.status)}` });
  const leaked = textOf(answers.otherTenant.body).includes(bMarker);
  if (leaked) findings.push({ route, rule: 'RS6', location, marker: bMarker, detail: 'other tenant record exposed' });
  else if (errorShape(answers.otherTenant) !== errorShape(answers.missing)) {
    findings.push({ route, rule: 'RS6', location, detail: 'other tenant id answers differently from a nonexistent id' });
  }
  return findings;
}

/** Text that must never appear through A: B's markers. */
export function containsAny(body: unknown, markers: readonly string[]): string[] {
  const text = textOf(body);
  return markers.filter((m) => text.includes(m));
}
