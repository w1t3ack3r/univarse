// Spec 0010: S3-compatible storage (SeaweedFS locally, ADR-025). Quarantine receives uploads through
// presigned POST (D1); the clean bucket is written only by the worker and never presigned.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

export const UPLOAD_TTL_SEC = 300;

export type BoundedRead = { kind: 'ok'; bytes: Buffer } | { kind: 'missing' } | { kind: 'too_large' };
export type StreamRead = { kind: 'ok'; body: Readable; length: number } | { kind: 'missing' };

/** Spec 0038 Q-B1: parts of 8 MiB (S3's minimum is 5), so at most two are in memory at once. */
export const PART_BYTES = 8 * 1024 * 1024;

/** One object written in parts, as its bytes arrive: nothing on disk, at most a part and a half in memory. */
export interface MultipartWrite {
  write(chunk: Uint8Array): Promise<void>;
  /** Uploads what's left and completes the object. (Not `complete`: the writer-bound check reads that name as a writer's.) */
  finish(): Promise<void>;
  /** Abandons the upload: its parts are removed. Safe to call more than once. */
  abort(): Promise<void>;
}

const isMissing = (err: unknown) =>
  (err as { name?: string }).name === 'NoSuchKey' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

@Injectable()
export class FileStorage implements OnModuleDestroy {
  private readonly s3: S3Client;
  /** Presigns with the public origin, so the browser's POST matches the signature (D1). */
  private readonly publicS3: S3Client;
  readonly quarantine: string;
  readonly clean: string;
  /** Spec 0038 Q-B1: the institutions' exports, kept 7 days, never in a backup. */
  readonly exports: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const credentials = { accessKeyId: config.S3_ACCESS_KEY ?? '', secretAccessKey: config.S3_SECRET_KEY ?? '' };
    this.s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials });
    this.publicS3 = new S3Client({ endpoint: config.S3_PUBLIC_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials });
    this.quarantine = config.S3_QUARANTINE_BUCKET;
    this.clean = config.S3_CLEAN_BUCKET;
    this.exports = config.S3_EXPORTS_BUCKET;
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

  /** The object's bytes as a stream, with its length, or missing. The caller reads or destroys the stream. */
  async stream(bucket: string, key: string): Promise<StreamRead> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { kind: 'ok', body: out.Body as Readable, length: out.ContentLength ?? 0 };
    } catch (err) {
      if (isMissing(err)) return { kind: 'missing' };
      throw err;
    }
  }

  /** Spec 0038 Q-B1: writes one object in parts as its bytes arrive (the worker has no disk to spare). */
  async multipart(bucket: string, key: string, contentType: string): Promise<MultipartWrite> {
    const created = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error('storage gave no upload id');
    const parts: { ETag: string; PartNumber: number }[] = [];
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let done = false;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const body = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const PartNumber = parts.length + 1;
      const out = await this.s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber, Body: body, ContentLength: body.length }));
      if (!out.ETag) throw new Error('storage gave no part tag');
      parts.push({ ETag: out.ETag, PartNumber });
    };
    return {
      write: async (chunk) => {
        if (done) throw new Error('multipart upload already finished');
        // A copy: the writer may reuse its buffer once this returns.
        pending.push(Buffer.from(chunk));
        pendingBytes += chunk.byteLength;
        if (pendingBytes >= PART_BYTES) await flush();
      },
      finish: async () => {
        if (done) throw new Error('multipart upload already finished');
        await flush();
        // An empty object still needs one part.
        if (parts.length === 0) {
          const out = await this.s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: 1, Body: Buffer.alloc(0), ContentLength: 0 }));
          parts.push({ ETag: out.ETag ?? '', PartNumber: 1 });
        }
        await this.s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
        done = true;
      },
      abort: async () => {
        if (done) return;
        done = true;
        pending = [];
        await this.s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      },
    };
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
