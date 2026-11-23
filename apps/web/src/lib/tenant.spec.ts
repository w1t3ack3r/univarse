import { describe, expect, it } from 'vitest';
import { suspendedInstitution } from './tenant';

const body = (institution: unknown, code = 'tenant.suspended') => ({ code, status: 423, institution });
const PPT = { legalName: 'Paused Polytechnic', shortName: 'PPT', primaryColor: '#1F4E79', textColor: '#FFFFFF' };
const SUSPENDED = { ...PPT, kind: 'suspended' };

describe('suspendedInstitution (spec 0037 Q8)', () => {
  it('reads a suspended institution’s name and colours from its 423', () => {
    expect(suspendedInstitution(body(PPT))).toEqual(SUSPENDED);
  });

  it('reads a closed institution’s from its 410, marked closed (spec 0038 Q5)', () => {
    expect(suspendedInstitution({ code: 'tenant.archived', status: 410, institution: PPT })).toEqual({ ...PPT, kind: 'closed' });
  });

  it('reads one in maintenance from its 503, marked maintenance (spec 0039 Q10)', () => {
    expect(suspendedInstitution({ code: 'tenant.maintenance', status: 503, institution: PPT })).toEqual({ ...PPT, kind: 'maintenance' });
    // A busy database is a 503 too, but not this page: it's an error with its own message.
    expect(suspendedInstitution({ code: 'server.busy', status: 503, institution: PPT })).toBeNull();
  });

  it('is null for any other problem, or a body without a usable name', () => {
    expect(suspendedInstitution(body(PPT, 'tenant.not_found'))).toBeNull();
    expect(suspendedInstitution(null)).toBeNull();
    expect(suspendedInstitution(body(undefined))).toBeNull();
    expect(suspendedInstitution(body({ ...PPT, legalName: '' }))).toBeNull();
    expect(suspendedInstitution(body({ ...PPT, shortName: 42 }))).toBeNull();
  });

  it('drops colours that aren’t plain #RRGGBB, as a pair: a page never gets half a palette or injected CSS', () => {
    const plain = { legalName: PPT.legalName, shortName: PPT.shortName, primaryColor: null, textColor: null, kind: 'suspended' };
    expect(suspendedInstitution(body({ ...PPT, primaryColor: 'red;background:url(x)' }))).toEqual(plain);
    expect(suspendedInstitution(body({ ...PPT, textColor: null }))).toEqual(plain);
  });
});
