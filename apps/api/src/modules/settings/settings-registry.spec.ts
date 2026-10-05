// Spec 0007 D3/ST4: permissions stay narrow as the registry grows.
import { PERMISSIONS, SETTINGS, type SettingDef } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';

const entries = Object.entries(SETTINGS) as [string, SettingDef][];

describe('settings registry', () => {
  it('[ST4] registration keys are managed by settings.registration.manage, and nothing else is', () => {
    for (const [key, def] of entries) {
      expect(def.manage === 'settings.registration.manage', key).toBe(key.startsWith('registration.'));
    }
  });

  it('[ST4] every manage permission is privileged and needs step-up', () => {
    for (const [key, def] of entries) expect(PERMISSIONS[def.manage], key).toMatchObject({ privileged: true, stepUp: true });
  });

  it('[ST1] every default validates against its own schema', () => {
    for (const [key, def] of entries) expect(def.schema.safeParse(def.default).success, key).toBe(true);
  });
});
