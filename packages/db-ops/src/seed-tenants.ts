// The seed's demo tenants (docs/07 §11), on their own with no imports, so a test can check them without a database
// client (spec 0027 P2: none may hold a reserved name).
export const TENANTS = [
  { slug: 'demo-uni', legalName: 'Demo University, Lagos', shortName: 'DEMO-UNI', type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE' },
  { slug: 'test-poly', legalName: 'Test State Polytechnic', shortName: 'TESTPOLY', type: 'POLYTECHNIC', ownership: 'STATE', status: 'ACTIVE' },
  { slug: 'paused-uni', legalName: 'Paused University', shortName: 'PAUSED', type: 'UNIVERSITY', ownership: 'FEDERAL', status: 'SUSPENDED' },
] as const;
