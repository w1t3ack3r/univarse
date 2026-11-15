// Spec 0038 Q8, Q-B1: where an export's archive lives and what its sealed passphrase is bound to.

/** Q8: the passphrase's AAD names the institution and the export, so a sealed value can't be moved to another. */
export const exportPassphraseAad = (tenantId: string, exportId: string) => `${tenantId}:data_export:${exportId}:passphrase`;

/** Every archive of one export sits under this prefix, inside its institution's own (`tenants/{tenantId}/`). */
export const exportArchivePrefix = (tenantId: string, exportId: string) => `tenants/${tenantId}/exports/${exportId}/`;

/** One builder's archive: its lease token in the name, so a builder that lost its lease never overwrites another's. */
export const exportArchiveKey = (tenantId: string, exportId: string, token: string) => `${exportArchivePrefix(tenantId, exportId)}${token}.zip`;

/** Whether a stored key is one of this export's archives, and nothing else. */
export const isExportArchiveKey = (tenantId: string, exportId: string, key: string) =>
  key.startsWith(exportArchivePrefix(tenantId, exportId)) && /^[0-9a-f-]{36}\.zip$/.test(key.slice(exportArchivePrefix(tenantId, exportId).length));
