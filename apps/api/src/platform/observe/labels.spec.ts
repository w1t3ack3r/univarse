import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_ACTION_GROUPS, AUDIT_ACTION_LABELS, auditActionLabel, SECURITY_EVENT_TEXT, securityEventText } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { SECURITY_EVENTS } from '../../shared/observability/security.js';

// The API's own writers, and the key store's, which has its own package.
const SOURCES = [new URL('../../', import.meta.url), new URL('../../../../../packages/crypto/src/', import.meta.url)].map((u) => fileURLToPath(u));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !/\.spec\.ts$/.test(p) ? [p] : [];
  });
}

/** Every action literal the code writes into the platform's audit log. Tenant actions (auth.*, files.*) go to a tenant's own. */
function platformActions(): Set<string> {
  const found = new Set<string>();
  const shape = /\baction: '((?:platform|crypto|tenant|drill)\.[a-z0-9_.]+)'/g;
  for (const file of SOURCES.flatMap(sources)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(shape)) found.add(m[1] ?? '');
  }
  return found;
}

describe('the words staff read (spec 0031 Q4, Q13)', () => {
  it('names every audit action the code writes', () => {
    const actions = platformActions();
    expect(actions.size).toBeGreaterThan(25); // the scan itself still finds them
    expect([...actions].filter((a) => !Object.hasOwn(AUDIT_ACTION_LABELS, a)).sort()).toEqual([]);
  });

  it('labels nothing the code doesn’t write: a label left over is a wrong name somewhere', () => {
    const actions = platformActions();
    expect(Object.keys(AUDIT_ACTION_LABELS).filter((a) => !actions.has(a)).sort()).toEqual([]);
  });

  it('says what every security event is and what to do', () => {
    expect(Object.keys(SECURITY_EVENT_TEXT).sort()).toEqual([...SECURITY_EVENTS].sort());
    for (const text of Object.values(SECURITY_EVENT_TEXT)) {
      expect(text.label.length).toBeGreaterThan(0);
      expect(text.todo.length).toBeGreaterThan(0);
    }
  });

  it('every filter group matches an action, and the API takes it', () => {
    const labelled = Object.keys(AUDIT_ACTION_LABELS);
    for (const g of AUDIT_ACTION_GROUPS) expect(labelled.some((a) => a.startsWith(`${g.value}.`))).toBe(true);
  });

  it('shows an unknown name raw, never nothing', () => {
    expect(auditActionLabel('platform.future.thing')).toBe('platform.future.thing');
    expect(securityEventText('future.event').label).toBe('future.event');
  });
});
