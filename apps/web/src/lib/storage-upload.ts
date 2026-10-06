// The one request that does NOT go to the API: the presigned POST straight to object storage (spec 0010
// D1). XHR, because fetch can't report upload progress on a slow phone. The lint rule against hand-written
// API calls names this file as its only exception (spec 0011 OA8).
import { ApiError, type ResponseBody } from '@univarse/api-client';

export type UploadSlot = ResponseBody<'/api/v1/files/uploads', 'post'>;

export function postToStorage(slot: UploadSlot, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', slot.upload.url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'file.upload_incomplete', undefined)));
    xhr.onerror = () => reject(new ApiError(0, 'network.offline', undefined));
    xhr.send(form);
  });
}
