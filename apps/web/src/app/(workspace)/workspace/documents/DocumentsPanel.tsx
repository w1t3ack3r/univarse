'use client';

import { messageFor } from '@univarse/contracts';
import { Button, Card, Check, Clock, FileText, Notice, ShieldAlert, Upload } from '@univarse/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, client, contentUrl, unwrap, type ResponseBody } from '@/lib/client-api';
import { postToStorage } from '@/lib/storage-upload';

/** Generated from the API contract (spec 0011): the API never returns deleted or abandoned files. */
export type FileView = ResponseBody<'/api/v1/files/{id}', 'get'>;

/** Same limits the API enforces (spec 0010 D3); checked here first so a slow phone doesn't upload in vain. */
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, readonly string[]> = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'] };
const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const POLL_MS = 2_000;

const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${String(Math.max(1, Math.round(n / 1024)))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const when = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' });

function localProblem(f: File): string | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? '').toLowerCase();
  if (!TYPES[f.type]?.includes(ext)) return messageFor('file.type_not_allowed');
  if (f.size > MAX_BYTES) return messageFor('file.too_large');
  if (f.size === 0) return 'That file is empty.';
  return null;
}

type Status = { label: string; tone: 'wait' | 'ok' | 'bad' | 'warn'; detail?: string };
function statusOf(f: FileView): Status {
  switch (f.state) {
    case 'CLEAN':
      return { label: 'Ready', tone: 'ok' };
    case 'INFECTED':
      return { label: 'Blocked', tone: 'bad', detail: 'This file contained a virus or something we couldn’t check fully, so it can’t be opened.' };
    case 'REJECTED':
      return { label: 'Not accepted', tone: 'bad', detail: 'Only PDF, PNG or JPEG files up to 5 MB, and the file must be what its name says.' };
    case 'SCAN_FAILED':
      return { label: 'Couldn’t check', tone: 'warn', detail: 'We couldn’t check this file for viruses. Delete it and upload it again.' };
    case 'PENDING_UPLOAD':
      return { label: 'Uploading', tone: 'wait' };
    default:
      return { label: 'Checking for viruses…', tone: 'wait' };
  }
}
const settled = (f: FileView) => !['PENDING_UPLOAD', 'UPLOADED', 'SCANNING'].includes(f.state);

export function DocumentsPanel({ initial }: { initial: FileView[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState(initial);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const upsert = useCallback((f: FileView) => setFiles((all) => [f, ...all.filter((x) => x.id !== f.id)]), []);

  // Poll the ones still being checked; a refresh mid-upload resumes from the server's state.
  useEffect(() => {
    const pending = files.filter((f) => !settled(f));
    if (pending.length === 0) return;
    const t = setTimeout(() => {
      void Promise.all(
        pending.map((f) =>
          unwrap(client.GET('/api/v1/files/{id}', { params: { path: { id: f.id } } }))
            .then(upsert)
            .catch(() => undefined),
        ),
      );
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [files, upsert]);

  async function choose(file: File) {
    setProblem(null);
    const local = localProblem(file);
    if (local) {
      setProblem({ text: local });
      return;
    }
    setBusy(true);
    try {
      const slot = await unwrap(client.POST('/api/v1/files/uploads', { body: { name: file.name, mime: file.type, sizeBytes: file.size } }));
      upsert(slot.file);
      await postToStorage(slot, file, (pct) => setProgress((p) => ({ ...p, [slot.file.id]: pct })));
      upsert(await unwrap(client.POST('/api/v1/files/{id}/complete', { params: { path: { id: slot.file.id } } })));
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
      setProblem({ text: e.message, requestId: e.requestId });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    setProblem(null);
    try {
      await unwrap(client.DELETE('/api/v1/files/{id}', { params: { path: { id } } }));
      setFiles((all) => all.filter((f) => f.id !== id));
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
      setProblem({ text: e.message, requestId: e.requestId });
    } finally {
      setConfirmDelete(null);
    }
  }

  return (
    <>
      <Card className="docs-upload">
        <span className="uv-icon-tile">
          <Upload />
        </span>
        <div className="docs-upload__text">
          <h2 className="docs-upload__title">Add a document</h2>
          <p className="docs-upload__hint">PDF, PNG or JPEG, up to 5 MB.</p>
        </div>
        <input
          ref={input}
          id="doc-file"
          className="docs-upload__input"
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void choose(f);
          }}
        />
        <label htmlFor="doc-file" className={busy ? 'uv-btn uv-btn--action docs-upload__button is-busy' : 'uv-btn uv-btn--action docs-upload__button'} aria-disabled={busy || undefined}>
          {busy ? <span className="uv-btn__spinner" aria-hidden="true" /> : null}
          {busy ? 'Uploading…' : 'Upload a document'}
        </label>
      </Card>

      {problem ? <Notice requestId={problem.requestId}>{problem.text}</Notice> : null}

      <section aria-labelledby="docs-list-title" className="docs">
        <h2 id="docs-list-title" className="section-title">
          Your documents
        </h2>
        {files.length === 0 ? (
          <Card>
            <div className="setting__empty">
              <span className="uv-icon-tile">
                <FileText />
              </span>
              <p>No documents yet. Documents you upload appear here once they’ve been checked.</p>
            </div>
          </Card>
        ) : (
          <Card>
            <ul className="list" aria-live="polite">
              {files.map((f) => {
                const s = statusOf(f);
                const pct = progress[f.id];
                return (
                  <li key={f.id} className="list__row doc-row">
                    <span className="uv-icon-tile doc-row__tile">
                      <FileText />
                    </span>
                    <span className="list__text">
                      <span className="list__title doc-row__name">{f.name}</span>
                      <span className="list__meta">
                        {sizeLabel(f.sizeBytes)} · {when.format(new Date(f.createdAt))}
                      </span>
                      {f.state === 'PENDING_UPLOAD' && pct !== undefined ? (
                        <span className="doc-row__bar" role="progressbar" aria-label={`Uploading ${f.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                          <span className="doc-row__fill" style={{ width: `${String(pct)}%` }} />
                        </span>
                      ) : null}
                      {s.detail ? <span className="doc-row__detail">{s.detail}</span> : null}
                    </span>
                    <span className="doc-row__end">
                      <span className={`status doc-status doc-status--${s.tone}`}>
                        {s.tone === 'ok' ? <Check size={14} /> : s.tone === 'wait' ? <Clock size={14} /> : <ShieldAlert size={14} />}
                        {s.label}
                      </span>
                      {confirmDelete === f.id ? (
                        <span className="doc-row__confirm" role="group" aria-label={`Delete ${f.name}?`}>
                          <Button type="button" variant="quiet" onClick={() => void remove(f.id)}>
                            Yes, delete
                          </Button>
                          <Button type="button" variant="plain" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <span className="doc-row__actions">
                          {f.state === 'CLEAN' ? (
                            <a className="uv-btn uv-btn--plain" href={contentUrl(f.id)} download>
                              Download<span className="uv-visually-hidden"> {f.name}</span>
                            </a>
                          ) : null}
                          {settled(f) ? (
                            <Button type="button" variant="plain" onClick={() => setConfirmDelete(f.id)}>
                              Delete<span className="uv-visually-hidden"> {f.name}</span>
                            </Button>
                          ) : null}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>
    </>
  );
}
