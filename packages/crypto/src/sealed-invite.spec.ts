import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalKeyProvider } from './providers.js';
import { openInvite, sealInvite } from './sealed-invite.js';

const provider = new LocalKeyProvider('provisioning', randomBytes(32).toString('base64'));
const details = { displayName: 'Ngozi Adeyemi', email: 'ngozi@unilag.edu.ng', username: 'ITADMIN' };

describe('spec 0034 Q7: a sealed invite', () => {
  it('opens for its own institution, and holds nothing readable', async () => {
    const t = randomUUID();
    const sealed = await sealInvite(provider, t, details);
    expect(sealed.startsWith('inv1:')).toBe(true);
    for (const v of Object.values(details)) expect(sealed).not.toContain(v);
    expect(await openInvite(provider, t, sealed)).toEqual(details);
  });

  it('refuses another institution, a tampered value, another key and a malformed one', async () => {
    const t = randomUUID();
    const sealed = await sealInvite(provider, t, details);
    await expect(openInvite(provider, randomUUID(), sealed)).rejects.toMatchObject({ reason: 'unwrap_failed' });
    const parts = sealed.split('|');
    parts[2] = Buffer.from('{"displayName":"x","email":"evil@x.ng","username":"X"}').toString('base64url');
    await expect(openInvite(provider, t, parts.join('|'))).rejects.toMatchObject({ reason: 'unwrap_failed' });
    const other = new LocalKeyProvider('other', randomBytes(32).toString('base64'));
    await expect(openInvite(other, t, sealed)).rejects.toMatchObject({ reason: 'unwrap_failed' });
    for (const bad of ['', 'inv1:', 'inv2:a|b|c|d', 'inv1:a|b|c']) await expect(openInvite(provider, t, bad)).rejects.toMatchObject({ reason: 'unwrap_failed' });
  });
});
