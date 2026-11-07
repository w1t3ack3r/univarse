// Spec 0028 Q5, Q14: the stack's owner command checks its line before any container starts.
import { describe, expect, it } from 'vitest';
import { ownerArgs, USAGE } from './console.js';

describe('[0028 Q5, Q14] pnpm stack:console owner', () => {
  it('the first OWNER: the email and the name, passed on as the CLI takes them', () => {
    expect(ownerArgs(['owner', '--email', 'ada@example.ng', '--name', 'Ada Obi'])).toEqual(['--email', 'ada@example.ng', '--name', 'Ada Obi']);
    expect(ownerArgs(['owner', '--name', 'Ada Obi', '--email', 'ada@example.ng'])).toEqual(['--email', 'ada@example.ng', '--name', 'Ada Obi']);
  });

  it('recovery: the email only, with the flag', () => {
    expect(ownerArgs(['owner', '--recover', '--email', 'ada@example.ng'])).toEqual(['--recover', '--email', 'ada@example.ng']);
    expect(ownerArgs(['owner', '--email', 'ada@example.ng', '--recover'])).toEqual(['--recover', '--email', 'ada@example.ng']);
  });

  it('[0032 Q10] correcting an address: both addresses, and the old one marked wrong only if asked', () => {
    expect(ownerArgs(['owner', '--correct-email', '--email', 'ada@gmal.com', '--new-email', 'ada@gmail.com'])).toEqual(['--correct-email', '--email', 'ada@gmal.com', '--new-email', 'ada@gmail.com']);
    expect(ownerArgs(['owner', '--correct-email', '--old-address-wrong', '--email', 'ada@gmal.com', '--new-email', 'ada@gmail.com'])).toEqual(['--correct-email', '--email', 'ada@gmal.com', '--new-email', 'ada@gmail.com', '--old-address-wrong']);
  });

  for (const [what, argv] of [
    ['a correction with no new address', ['owner', '--correct-email', '--email', 'ada@example.ng']],
    ['a correction with a bad new address', ['owner', '--correct-email', '--email', 'ada@example.ng', '--new-email', 'ada']],
    ['a correction and a recovery together', ['owner', '--correct-email', '--recover', '--email', 'ada@example.ng', '--new-email', 'b@example.ng']],
    ['the old address marked wrong without a correction', ['owner', '--recover', '--old-address-wrong', '--email', 'ada@example.ng']],
    ['no command', []],
    ['another command', ['staff', '--email', 'ada@example.ng', '--name', 'Ada']],
    ['no email', ['owner', '--name', 'Ada']],
    ['not an email', ['owner', '--email', 'ada', '--name', 'Ada']],
    ['no name', ['owner', '--email', 'ada@example.ng']],
    ['a blank name', ['owner', '--email', 'ada@example.ng', '--name', '  ']],
    ['a name with recovery', ['owner', '--recover', '--email', 'ada@example.ng', '--name', 'Ada']],
    ['an unknown flag', ['owner', '--email', 'ada@example.ng', '--name', 'Ada', '--role', 'OWNER']],
    ['a flag given twice', ['owner', '--email', 'a@example.ng', '--email', 'b@example.ng', '--name', 'Ada']],
    ['a flag with no value', ['owner', '--name', 'Ada', '--email']],
    ['a flag where its value should be', ['owner', '--email', '--name', 'Ada']],
  ] as const)
    it(`refuses ${what}, with the usage`, () => {
      expect(() => ownerArgs(argv)).toThrow(USAGE);
    });
});
