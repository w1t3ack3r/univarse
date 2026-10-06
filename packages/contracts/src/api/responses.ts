// Spec 0011 OA4: success bodies as they are SERIALIZED (ids and timestamps are strings on the wire).
// Strict: a renamed or extra field fails conformance (OA10/OA11). Written from recorded real traffic.
import { z } from 'zod';
import { PERMISSIONS } from '../permissions.js';
import { PRODUCTS } from '../products.js';
import { SETTING_KEYS, SETTINGS, type SettingKey } from '../settings.js';

const Uuid = z.string().meta({ format: 'uuid' });
const Instant = z.string().meta({ format: 'date-time' });

export const MessageResponse = z.object({ message: z.string() }).strict();

export const UserSummary = z.object({ id: Uuid, username: z.string(), displayName: z.string() }).strict();

/** Either a second factor is needed (challenge cookie set), or the user is signed in (session set). */
export const LoginResponse = z.union([
  z.object({ mfaRequired: z.literal(true) }).strict(),
  z.object({ user: UserSummary, mfaEnrolmentRequired: z.literal(true).optional() }).strict(),
]);
export const StepUpResponse = z.object({ stepUp: z.literal(true) }).strict();
export const MeResponse = z
  .object({
    id: Uuid,
    username: z.string(),
    displayName: z.string(),
    mfa: z.boolean(),
    restricted: z.boolean(),
    permissions: z.array(z.enum(Object.keys(PERMISSIONS) as [string, ...string[]])),
  })
  .strict();

export const MfaVerifyResponse = z.object({ user: UserSummary }).strict();
export const TotpDisabledResponse = z.object({ mfa: z.literal(false), mfaEnrolmentRequired: z.literal(true).optional() }).strict();
export const RecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) }).strict();
export const TotpEnrolmentResponse = z.object({ secret: z.string(), otpauthUri: z.string() }).strict();

export const UserRow = z
  .object({
    id: Uuid,
    username: z.string(),
    displayName: z.string(),
    status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'LOCKED', 'DISABLED']),
    lastLoginAt: Instant.nullable(),
  })
  .strict();
export const UserList = z.object({ data: z.array(UserRow) }).strict();

export const ActiveProducts = z.object({ data: z.array(z.enum(PRODUCTS)) }).strict();
export const ProductStateResponse = z.object({ product: z.enum(PRODUCTS), entitled: z.boolean(), enabled: z.boolean(), active: z.boolean() }).strict();
export const ProductOverview = z.object({ data: z.array(ProductStateResponse) }).strict();

/**
 * One variant per registry key: `key` is a literal, and `value`/`default` are THAT key's schema, so the
 * key → value relationship is exact in responses (the key is in the body here, unlike requests).
 */
const settingView = (key: SettingKey) =>
  z
    .object({
      key: z.literal(key),
      label: z.string(),
      value: SETTINGS[key].schema,
      default: SETTINGS[key].schema,
      source: z.enum(['default', 'tenant']),
      version: z.number().int().min(0),
      updatedAt: Instant.nullable(),
      updatedBy: z.object({ id: Uuid, displayName: z.string() }).strict().nullable(),
      canManage: z.boolean(),
    })
    .strict();
export const SettingViewResponse = z.union(SETTING_KEYS.map(settingView) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
export const SettingList = z.object({ data: z.array(SettingViewResponse) }).strict();

export const FILE_DOWNLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const FileViewResponse = z
  .object({
    id: Uuid,
    name: z.string(),
    sizeBytes: z.number().int().min(1),
    state: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'CLEAN', 'INFECTED', 'REJECTED', 'SCAN_FAILED']),
    type: z.enum(FILE_DOWNLOAD_TYPES).nullable(),
    rejectionReason: z.string().nullable(),
    createdAt: Instant,
    scannedAt: Instant.nullable(),
  })
  .strict();
export const FileList = z.object({ data: z.array(FileViewResponse) }).strict();
/** The presigned POST goes to storage, not to the API (spec 0010 D1); its fields are opaque strings. */
export const UploadSlotResponse = z
  .object({
    file: FileViewResponse,
    upload: z.object({ url: z.string(), fields: z.record(z.string(), z.string()) }).strict(),
    expiresAt: Instant,
  })
  .strict();

export const PublicProfileResponse = z
  .object({ slug: z.string(), shortName: z.string(), legalName: z.string(), type: z.enum(['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION']) })
  .strict();

export const LiveResponse = z.object({ status: z.literal('ok') }).strict();
export const ReadyResponse = z.object({ status: z.literal('ready') }).strict();
