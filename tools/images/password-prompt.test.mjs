// The release's hidden prompt (spec 0013 LR5): a pasted password arrives intact. A terminal in bracketed-paste mode
// wraps a paste in ESC[200~ … ESC[201~, which must not become part of the password. `node --test` this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTypedPassword } from './release-lib.mjs';

const ESC = String.fromCharCode(27);
const PASSWORD = 'Tr0ub4dor &3 ñ-Ω';

test('[LR5] a typed password is kept exactly, spaces and non-ASCII letters included', () => {
  assert.equal(cleanTypedPassword(PASSWORD), PASSWORD);
});

test('[LR5] a bracketed paste yields the password without its markers', () => {
  assert.equal(cleanTypedPassword(`${ESC}[200~${PASSWORD}${ESC}[201~`), PASSWORD);
});

test('[LR5] other escape sequences and control characters are dropped', () => {
  assert.equal(cleanTypedPassword(`${ESC}[A${PASSWORD}${String.fromCharCode(22)}${ESC}O`), PASSWORD);
  assert.equal(cleanTypedPassword(`a${String.fromCharCode(0)}b${String.fromCharCode(127)}c`), 'abc');
});
