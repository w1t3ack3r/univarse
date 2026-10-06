// Spec 0011: settings through one operation, with the key → value relationship the document records in
// `x-value-by-key` carried into the types. The key picks the value type (SettingValue<K> from the
// registry) and narrows the response to that key's variant. Writes send If-Match and return the new ETag.
import type { SettingKey, SettingValue } from '@univarse/contracts';
import { ApiError, unwrap, type Api } from './client.js';
import type { paths } from './schema.js';

type AnyView = paths['/api/v1/settings/{key}']['get']['responses'][200]['content']['application/json'];
/** The response variant for one key: `key` is that literal, `value`/`default` that key's shape. */
export type SettingViewOf<K extends SettingKey> = Extract<AnyView, { key: K }>;

export interface Versioned<K extends SettingKey> {
  readonly view: SettingViewOf<K>;
  /** Send back as If-Match on the next write (docs/06 §ETag). */
  readonly etag: string;
}

async function versioned<K extends SettingKey>(
  call: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<Versioned<K>> {
  const pending = call.then((r) => ({ ...r, etag: r.response.headers.get('etag') }));
  const view = (await unwrap(pending)) as SettingViewOf<K>;
  const etag = (await pending).etag;
  // The document makes ETag required on these responses; its absence is a broken answer, not "no version".
  if (!etag) throw new ApiError(200, 'server.unexpected_response', undefined);
  return { view, etag };
}

export const getSetting = <K extends SettingKey>(api: Api, key: K) =>
  versioned<K>(api.GET('/api/v1/settings/{key}', { params: { path: { key } } }));

export const putSetting = <K extends SettingKey>(api: Api, key: K, value: SettingValue<K>, etag: string) =>
  versioned<K>(
    api.PUT('/api/v1/settings/{key}', {
      params: { path: { key }, header: { 'If-Match': etag } },
      // `value` is documented as the union of every key's shape; SettingValue<K> is K's member of it.
      body: { value },
    }),
  );

export const resetSetting = <K extends SettingKey>(api: Api, key: K, etag: string) =>
  versioned<K>(api.DELETE('/api/v1/settings/{key}', { params: { path: { key }, header: { 'If-Match': etag } } }));
