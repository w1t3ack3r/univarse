/**
 * Spec 0010 FU11 — storage contract tests (ADR-025). They record what the S3-compatible backend
 * ACTUALLY does, so no part of the design rests on an assumption. The first test is the D1 gate:
 * does a presigned POST policy's `content-length-range` refuse an oversize upload?
 * Prereqs: `pnpm dev:infra` (SeaweedFS with buckets), `.env` with S3_* keys.
 */
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, describe, expect, it } from 'vitest';

const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333';
const bucket = process.env.S3_QUARANTINE_BUCKET ?? 'uv-quarantine';
const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
});
const created: string[] = [];
const key = () => {
  const k = `contract/${randomUUID()}`;
  created.push(k);
  return k;
};
const bytes = (n: number, fill = 0x61) => Buffer.alloc(n, fill);

/** Multipart POST exactly as a browser form would send it. */
async function postForm(url: string, fields: Record<string, string>, body: Buffer, contentType = 'application/pdf') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([body], { type: contentType }), 'upload.bin');
  const res = await fetch(url, { method: 'POST', body: form });
  return { status: res.status, text: await res.text() };
}
const exists = async (k: string) => {
  try {
    const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: k }));
    return Buffer.from(await o.Body!.transformToByteArray());
  } catch {
    return null;
  }
};

/** Observations, printed for the spec's results table. */
const observed: Record<string, string> = {};

afterAll(async () => {
  for (const k of created) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })).catch(() => undefined);
  process.stdout.write(`\n[storage-contract] ${endpoint} ${JSON.stringify(observed)}\n`);
});

describe('[FU11] storage contract (what the backend actually does)', () => {
  it('[FU11][D1] presigned POST: an upload within content-length-range is accepted, an oversize one is refused', async () => {
    const limit = 1024;
    const kOk = key();
    const ok = await createPresignedPost(s3, {
      Bucket: bucket,
      Key: kOk,
      Conditions: [['content-length-range', 1, limit], ['eq', '$Content-Type', 'application/pdf']],
      Fields: { 'Content-Type': 'application/pdf' },
      Expires: 300,
    });
    const within = await postForm(ok.url, ok.fields, bytes(limit));
    observed.postWithinLimit = String(within.status);
    expect([200, 201, 204]).toContain(within.status); // baseline: the path works at all
    expect((await exists(kOk))?.length).toBe(limit);

    const kBig = key();
    const big = await createPresignedPost(s3, {
      Bucket: bucket,
      Key: kBig,
      Conditions: [['content-length-range', 1, limit], ['eq', '$Content-Type', 'application/pdf']],
      Fields: { 'Content-Type': 'application/pdf' },
      Expires: 300,
    });
    const over = await postForm(big.url, big.fields, bytes(limit * 4));
    const stored = await exists(kBig);
    observed.postOverLimit = `${String(over.status)}${stored ? ` (STORED ${String(stored.length)} bytes)` : ' (nothing stored)'}`;
    // The D1 gate (decided: enforced, so uploads use presigned POST; spec 0010 D1).
    expect(stored, 'an oversize POST must not be stored').toBeNull();
    expect(over.status).toBeGreaterThanOrEqual(400);

    // The exact boundary: one byte over is refused too.
    const kEdge = key();
    const edge = await createPresignedPost(s3, {
      Bucket: bucket,
      Key: kEdge,
      Conditions: [['content-length-range', 1, limit], ['eq', '$Content-Type', 'application/pdf']],
      Fields: { 'Content-Type': 'application/pdf' },
      Expires: 300,
    });
    const oneOver = await postForm(edge.url, edge.fields, bytes(limit + 1));
    const edgeStored = await exists(kEdge);
    observed.postOneByteOver = `${String(oneOver.status)}${edgeStored ? ` (STORED ${String(edgeStored.length)} bytes)` : ' (nothing stored)'}`;
    expect(edgeStored, 'limit + 1 bytes must not be stored').toBeNull();
  });

  it('[FU11] presigned POST: a different key than the policy fixes is refused', async () => {
    const k = key();
    const p = await createPresignedPost(s3, { Bucket: bucket, Key: k, Conditions: [['content-length-range', 1, 1024]], Expires: 300 });
    const other = `${k}-other`;
    created.push(other);
    const res = await postForm(p.url, { ...p.fields, key: other }, bytes(10));
    observed.postOtherKey = `${String(res.status)}${(await exists(other)) ? ' (STORED)' : ' (nothing stored)'}`;
    expect(await exists(other)).toBeNull();
  });

  it('[FU11] presigned POST and PUT can be reused before expiry and overwrite (recorded; FU4 makes it harmless)', async () => {
    const k = key();
    const p = await createPresignedPost(s3, { Bucket: bucket, Key: k, Conditions: [['content-length-range', 1, 1024]], Expires: 300 });
    await postForm(p.url, p.fields, bytes(10, 0x61));
    const again = await postForm(p.url, p.fields, bytes(10, 0x62));
    observed.postReuse = `${String(again.status)}${(await exists(k))?.[0] === 0x62 ? ' (OVERWROTE)' : ' (kept first)'}`;

    const k2 = key();
    const put = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: k2 }), { expiresIn: 300 });
    await fetch(put, { method: 'PUT', body: bytes(10, 0x61) });
    const putAgain = await fetch(put, { method: 'PUT', body: bytes(10, 0x62) });
    observed.putReuse = `${String(putAgain.status)}${(await exists(k2))?.[0] === 0x62 ? ' (OVERWROTE)' : ' (kept first)'}`;
    expect(true).toBe(true); // recorded only
  });

  it('[FU11] conditional write: If-None-Match: * on an existing key (recorded)', async () => {
    const k = key();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: bytes(10, 0x61) }));
    let outcome: string;
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: bytes(10, 0x62), IfNoneMatch: '*' }));
      outcome = (await exists(k))?.[0] === 0x62 ? 'ignored (OVERWROTE)' : 'accepted but kept first';
    } catch (err) {
      outcome = `refused (${String((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)})`;
    }
    observed.ifNoneMatch = outcome;
    expect(outcome).toBeTruthy();
  });

  it('[FU11] presigned URLs stop working after expiry', async () => {
    const k = key();
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: k }), { expiresIn: 1 });
    await new Promise((r) => setTimeout(r, 2_500));
    const res = await fetch(url, { method: 'PUT', body: bytes(10) });
    observed.putAfterExpiry = String(res.status);
    expect(res.status).toBe(403);
    expect(await exists(k)).toBeNull();
  });

  it('[FU1][FU11] private bucket: an anonymous read is refused', async () => {
    const k = key();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: bytes(10) }));
    const res = await fetch(`${endpoint}/${bucket}/${k}`);
    observed.anonymousGet = String(res.status);
    expect(res.status).toBe(403);
  });
});
