import { describe, expect, it } from 'vitest';
import {
  goLiveChecklist,
  maskEmail,
  nextStep,
  PROVISIONING_STEPS,
  slugProblem,
  statusBeforeStep,
  templateForType,
  templateRef,
  TEMPLATES,
  type GoLiveFacts,
} from './provisioning.js';

describe('spec 0034: provisioning rules', () => {
  it('[Q5] a slug is 3 to 40 lower-case letters, digits and single hyphens, and never a reserved name', () => {
    for (const ok of ['unilag', 'fed-poly-ilaro', 'coe2', 'abc', `a${'b'.repeat(39)}`]) expect([ok, slugProblem(ok)]).toEqual([ok, null]);
    for (const bad of ['ab', 'Unilag', '2poly', '-poly', 'poly-', 'fed--poly', 'uni lag', 'uni_lag', 'uni.lag', '', `a${'b'.repeat(40)}`]) {
      expect([bad, slugProblem(bad)]).toEqual([bad, 'format']);
    }
    expect(slugProblem('console')).toBe('reserved');
    expect(slugProblem('www')).toBe('reserved');
  });

  it('[Q5] eight steps in order; a resumed job starts at the first one not done', () => {
    expect(PROVISIONING_STEPS).toEqual(['place', 'key', 'seed', 'template', 'host', 'products', 'invite', 'done']);
    expect(nextStep(new Set())).toBe('place');
    expect(nextStep(new Set(['place', 'key']))).toBe('seed');
    expect(nextStep(new Set(['place', 'seed']))).toBe('key');
    expect(nextStep(new Set(PROVISIONING_STEPS))).toBeNull();
    expect(statusBeforeStep('place')).toBe('REQUESTED');
    for (const s of PROVISIONING_STEPS.slice(1)) expect(statusBeforeStep(s)).toBe('PROVISIONING');
  });

  it('[Q6] each type proposes its own template, versioned', () => {
    expect(templateForType('UNIVERSITY')).toBe('university');
    expect(templateForType('POLYTECHNIC')).toBe('polytechnic');
    expect(templateForType('COLLEGE_OF_EDUCATION')).toBe('college-of-education');
    expect(templateRef(TEMPLATES.polytechnic)).toBe('polytechnic@1');
    for (const t of Object.values(TEMPLATES)) expect(Object.keys(t.settings)).toEqual(['registration.unitLimits']);
  });

  const ready: GoLiveFacts = {
    status: 'ONBOARDING',
    adminReadyAt: new Date(),
    entitled: ['core', 'academics'],
    primaryColor: '#0B3D91',
    state: 'Lagos',
    operatingStatus: 'APPROVED',
    dpaRecorded: true,
  };

  it('[Q9] the checklist passes only when every item does, and only while onboarding', () => {
    expect(goLiveChecklist(ready).ready).toBe(true);
    const failing = (f: Partial<GoLiveFacts>) =>
      goLiveChecklist({ ...ready, ...f })
        .items.filter((i) => !i.passed)
        .map((i) => i.item);
    expect(failing({ adminReadyAt: null })).toEqual(['admin_ready']);
    expect(failing({ entitled: ['core'] })).toEqual(['products']);
    expect(failing({ primaryColor: null })).toEqual(['branding']);
    expect(failing({ state: null })).toEqual(['regulatory']);
    expect(failing({ operatingStatus: 'UNKNOWN' })).toEqual(['regulatory']);
    expect(failing({ dpaRecorded: false })).toEqual(['dpa']);
    expect(goLiveChecklist({ ...ready, primaryColor: null }).ready).toBe(false);
    expect(goLiveChecklist({ ...ready, status: 'ACTIVE' }).ready).toBe(false);
    expect(goLiveChecklist({ ...ready, status: 'PROVISIONING' }).ready).toBe(false);
  });

  it('[Q7] the masked email keeps the first letter and the domain only', () => {
    expect(maskEmail('ngozi.adeyemi@unilag.edu.ng')).toBe('n•••@unilag.edu.ng');
    expect(maskEmail('@x.ng')).toBe('•••');
    expect(maskEmail('nobody')).toBe('•••');
  });
});
