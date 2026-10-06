// Spec 0010: S3-compatible storage (SeaweedFS locally, ADR-025). Quarantine receives uploads through
// presigned POST (D1); the clean bucket is written only by the worker and never presigned.
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export const UPLOAD_TTL_SEC = 300;

export type BoundedRead = { kind: 'ok'; bytes: Buffer } | { kind: 'missing' } | { kind: 'too_large' };

@Injectable()
export class FileStorage implements OnModuleDestroy {
  private readonly s3: S3Client;
  /** Presigns with the public origin, so the browser's POST matches the signature (D1). */
  private readonly publicS3: S3Client;
  readonly quarantine: string;
  readonly clean: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const credentials = { accessKeyId: config.S3_ACCESS_KEY ?? '', secretAccessKey: config.S3_SECRET_KEY ?? '' };
    this.s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials });
    this.publicS3 = new S3Client({ endpoint: config.S3_PUBLIC_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials });
    this.quarantine = config.S3_QUARANTINE_BUCKET;
    this.clean = config.S3_CLEAN_BUCKET;
  }

  onModuleDestroy(): void {
    this.s3.destroy();
    this.publicS3.destroy();
  }

  /** A one-key, size-bounded, typed upload slot (FU5, FU11): the backend refuses anything else. */
  async presignUpload(key: string, mime: string, maxBytes: number): Promise<{ url: string; fields: Record<string, string> }> {
    return createPresignedPost(this.publicS3, {
      Bucket: this.quarantine,
      Key: key,
      Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', mime]],
      Fields: { 'Content-Type': mime },
      Expires: UPLOAD_TTL_SEC,
    });
  }

  /** Reads at most `maxBytes`; one byte more means too large. The bound is enforced while reading. */
  async readBounded(bucket: string, key: string, maxBytes: number): Promise<BoundedRead> {
    let body: AsyncIterable<Uint8Array>;
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      body = out.Body as AsyncIterable<Uint8Array>;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return { kind: 'missing' };
      }
      throw err;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop reading: the rest is never pulled into memory.
        (body as unknown as { destroy?: () => void }).destroy?.();
        return { kind: 'too_large' };
      }
      chunks.push(Buffer.from(chunk));
    }
    return { kind: 'ok', bytes: Buffer.concat(chunks, total) };
  }

  async put(bucket: string, key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length }));
  }

  /** Up to `max` keys under a prefix (cleanup of orphaned quarantine objects, FU7). */
  async listKeys(bucket: string, prefix: string, max: number): Promise<string[]> {
    const out = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: max }));
    return (out.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
  }

  /** Idempotent: deleting a missing object is fine. */
  async remove(bucket: string, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
