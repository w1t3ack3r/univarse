// Spec 0011 OA1 (one zod) and OA3 (the moved request schemas keep their exact behaviour).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodeConfirmBody, FileUploadRequestBody, LoginBody, MfaVerifyBody, SettingWriteBody, StepUpBody } from './index.js';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('[OA1] one zod version across the workspace', () => {
  it('[OA1] the lockfile resolves exactly one zod, the catalog version', () => {
    const resolved = [...read('pnpm-lock.yaml').matchAll(/^ {2}zod@([^:(\s]+):/gm)].map((m) => m[1]);
    const catalog = /^catalog:\s*\n(?:\s+.*\n)*?\s+zod:\s*(\S+)/m.exec(read('pnpm-workspace.yaml'))?.[1];
    expect(new Set(resolved)).toEqual(new Set([catalog]));
  });

  it('[OA1] every workspace package takes zod from the catalog', () => {
    for (const pkg of ['apps/api/package.json', 'packages/contracts/package.json']) {
      const { dependencies } = JSON.parse(read(pkg)) as { dependencies: Record<string, string> };
      expect(dependencies.zod, pkg).toBe('catalog:');
    }
  });
});

describe('[OA3] request schemas moved to contracts behave as before', () => {
  const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

  it('[OA3] strict: unknown fields are refused (docs/06 §2)', () => {
    expect(ok(LoginBody, { username: 'a', password: 'b' })).toBe(true);
    expect(ok(LoginBody, { username: 'a', password: 'b', admin: true })).toBe(false);
    expect(ok(SettingWriteBody, { value: 1, extra: 1 })).toBe(false);
    expect(ok(FileUploadRequestBody, { name: 'a.pdf', mime: 'application/pdf', sizeBytes: 1, path: '/x' })).toBe(false);
  });

  it('[OA3] field rules: trimmed identifiers, 6-digit codes, whole positive sizes', () => {
    expect(LoginBody.parse({ username: '  u1  ', password: 'p' }).username).toBe('u1');
    expect(ok(LoginBody, { username: '   ', password: 'p' })).toBe(false);
    expect(ok(CodeConfirmBody, { username: 'u', code: '12345', password: 'p' })).toBe(false);
    expect(ok(CodeConfirmBody, { username: 'u', code: '123456', password: 'p' })).toBe(true);
    expect(ok(FileUploadRequestBody, { name: 'a.pdf', mime: 'application/pdf', sizeBytes: 1.5 })).toBe(false);
    expect(ok(FileUploadRequestBody, { name: 'a.pdf', mime: 'application/pdf', sizeBytes: 0 })).toBe(false);
  });

  it('[OA3] second factors: code or recovery code, never both', () => {
    expect(ok(StepUpBody, { password: 'p' })).toBe(true);
    expect(ok(StepUpBody, { password: 'p', code: '123456', recoveryCode: 'ABCDE-FGHIJ' })).toBe(false);
    expect(ok(MfaVerifyBody, { code: '123456' })).toBe(true);
    expect(ok(MfaVerifyBody, { recoveryCode: 'ABCDE-FGHIJ' })).toBe(true);
    expect(ok(MfaVerifyBody, { code: '123456', recoveryCode: 'ABCDE-FGHIJ' })).toBe(false);
  });
});
