// Request bodies for files, products and settings (spec 0011 OA3). The handler's `parse` uses these
// exact objects, and the OpenAPI document is generated from them.
import { z } from 'zod';

/** Spec 0010: the declared name, type and size of an upload; limits are checked by the use case. */
export const FileUploadRequestBody = z
  .object({ name: z.string().trim().min(1).max(255), mime: z.string().min(1).max(100), sizeBytes: z.number().int().min(1) })
  .strict();

export const ProductSetEnabledBody = z.object({ enabled: z.boolean(), reason: z.string().min(1) }).strict();

/**
 * The value is validated against the key's own schema by the use case (422 settings.invalid_value),
 * so it is `unknown` here. Spec 0011 step 2 documents it per key.
 */
export const SettingWriteBody = z.object({ value: z.unknown() }).strict();
