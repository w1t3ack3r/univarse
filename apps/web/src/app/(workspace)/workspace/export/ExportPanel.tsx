'use client';

import { Archive, ArrowRight, Button, Card, Check, ChevronDown, Clock, Download, Key, Notice, ShieldCheck } from '@univarse/ui';
import { CopyButton } from '@univarse/ui/client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, exportContentUrl, unwrap, type ResponseBody } from '@/lib/client-api';

/** Generated from the API contract (spec 0011). */
export type ExportList = ResponseBody<'/api/v1/exports', 'get'>;
type ExportView = ExportList['data'][number];

const day = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
const moment = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
const count = new Intl.NumberFormat('en-NG');

/** Bytes as people read them: kB below a megabyte, MB below a gigabyte. */
export function size(bytes: number): string {
  if (bytes < 1_000_000) return `${count.format(Math.max(1, Math.round(bytes / 1000)))} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;
const working = (e: ExportView) => e.state === 'REQUESTED' || e.state === 'BUILDING';

const STATE: Record<ExportView['state'], { label: string; tone: 'on' | 'off' | 'wait' | 'bad' }> = {
  REQUESTED: { label: 'Preparing', tone: 'wait' },
  BUILDING: { label: 'Preparing', tone: 'wait' },
  READY: { label: 'Ready', tone: 'on' },
  FAILED: { label: 'Didn’t finish', tone: 'bad' },
  EXPIRED: { label: 'Deleted', tone: 'off' },
};

/**
 * Q7, Q8 in the workspace: ask for an export, keep its passphrase (shown once), then download it when it's ready. Every
 * call is step-up gated; a 428 opens the dialog and retries once. While one is being prepared the list refreshes itself.
 */
export function ExportPanel({ initial, institution, closesAt }: { initial: ExportList; institution: string; closesAt: string | null }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [list, setList] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [stale, setStale] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const inProgress = list.data.some(working);

  // While one is being prepared: look again every 5 seconds, only while the page is visible. A 428 (the step-up has
  // lapsed) stops it quietly; the page says to refresh.
  const refresh = useCallback(async () => {
    const r = await client.GET('/api/v1/exports');
    if (r.response.status === 428) {
      setStale(true);
      return;
    }
    if (r.data) setList(r.data);
  }, []);
  useEffect(() => {
    if (!inProgress || stale) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [inProgress, stale, refresh]);

  useEffect(() => {
    if (passphrase) heading.current?.focus();
  }, [passphrase]);

  async function prepare() {
    setPending(true);
    setError(null);
    try {
      const made = await withStepUp(() => unwrap(client.POST('/api/v1/exports')));
      if (made) {
        setPassphrase(made.passphrase);
        setKept(false);
        setList((l) => ({ data: [made.export, ...l.data], nextAllowedAt: null }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
    } finally {
      setPending(false);
    }
  }

  /** Confirms the step-up first, so the browser never lands on an error instead of a file. */
  async function download(e: ExportView) {
    const url = exportContentUrl(e.id);
    if (!url) return;
    setError(null);
    try {
      const ok = await withStepUp(() => unwrap(client.GET('/api/v1/exports')));
      if (ok) window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
    }
  }

  const nextAt = list.nextAllowedAt ? new Date(list.nextAllowedAt) : null;

  return (
    <>
      {closesAt ? (
        <Notice tone="info">UniVarse closes for {institution} at the end of {day.format(new Date(closesAt))}. Take your copy before then: after it, no export can be made.</Notice>
      ) : null}

      {passphrase ? (
        <Card>
          <div className="export-key">
            <span className="uv-icon-tile">
              <Key />
            </span>
            <h2 ref={heading} tabIndex={-1} className="auth__heading">
              Keep this passphrase
            </h2>
            <p className="auth__sub">It opens the export. This is the only time it’s shown: without it, nobody can open the file, not your ICT unit and not UniVarse.</p>
            <ol className="passphrase" aria-label="Passphrase, in six groups">
              {passphrase.split('-').map((g, i) => (
                <li key={`${String(i)}-${g}`}>{g}</li>
              ))}
            </ol>
            <p className="codes-note">Capital letters and digits, without I, L, O or U, so nothing looks alike. Type it with or without the dashes.</p>
            <div className="row-actions">
              <CopyButton text={passphrase} label="Copy passphrase" />
            </div>
            <label className="check">
              <input type="checkbox" checked={kept} onChange={(ev) => setKept(ev.target.checked)} />
              <span>I’ve kept the passphrase somewhere safe, away from where the export will be saved.</span>
            </label>
            <Button
              type="button"
              block
              disabled={!kept}
              onClick={() => {
                setPassphrase(null);
                router.refresh();
              }}
            >
              Done
              <ArrowRight />
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="export-intro">
            <span className="uv-icon-tile">
              <Archive />
            </span>
            <div className="export-intro__text">
              <h2 className="section-title">Prepare an export</h2>
              <ul className="export-facts">
                <li>
                  <Check size={18} />
                  <span>Every record of {institution} as plain files any spreadsheet or database tool can read, and every uploaded document.</span>
                </li>
                <li>
                  <Key size={18} />
                  <span>Locked with a passphrase you see once, when you ask. No passwords or sign-in codes are in it.</span>
                </li>
                <li>
                  <Clock size={18} />
                  <span>Kept for 7 days, then deleted. One a day.</span>
                </li>
              </ul>
            </div>
          </div>
          {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
          {inProgress ? (
            <p className="export-wait" role="status">
              <span className="uv-btn__spinner" aria-hidden="true" />
              An export is being prepared. It shows below when it’s ready, usually within a few minutes.
            </p>
          ) : nextAt ? (
            <p className="export-wait">You can ask for the next one from {moment.format(nextAt)}.</p>
          ) : (
            <div>
              <Button type="button" pending={pending} onClick={() => void prepare()}>
                Prepare an export
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card>
        <h2 className="section-title">Your exports</h2>
        {stale ? <p className="export-wait">Refresh the page to see if it’s ready.</p> : null}
        {list.data.length === 0 ? (
          <p className="list__meta">None yet. When you prepare one, it shows here.</p>
        ) : (
          <ul className="list" aria-label="Exports">
            {list.data.map((e) => (
              <ExportRow key={e.id} e={e} onDownload={() => void download(e)} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ExportRow({ e, onDownload }: { e: ExportView; onDownload: () => void }) {
  const s = STATE[e.state];
  return (
    <li className="list__row export-row">
      <span className="list__text">
        <span className="list__title">Asked for {moment.format(new Date(e.requestedAt))}</span>
        <span className="list__meta">{e.requestedBy ? `By ${e.requestedBy.displayName}` : 'By a former user'}</span>
        {e.state === 'READY' && e.sizeBytes !== null ? (
          <span className="list__meta">
            {size(e.sizeBytes)} · {plural(e.rows ?? 0, 'record', 'records')} in {plural(e.tables ?? 0, 'table', 'tables')} · {plural(e.files ?? 0, 'document', 'documents')}
          </span>
        ) : null}
        {e.state === 'READY' && e.expiresAt ? <span className="list__meta">Available until {moment.format(new Date(e.expiresAt))}</span> : null}
        {e.state === 'FAILED' ? <span className="list__meta">Something went wrong while preparing it. You can ask for another now.</span> : null}
        {e.sha256 && e.state === 'READY' ? (
          <details className="disclosure export-hash">
            <summary>
              Check the download
              <ChevronDown size={16} />
            </summary>
            <div className="disclosure__body">
              <p className="codes-note">The file’s SHA-256 fingerprint. A checking tool gives the same one for an intact download.</p>
              <code className="export-hash__value">{e.sha256}</code>
            </div>
          </details>
        ) : null}
      </span>
      <span className="export-row__end">
        <span className={`status status--${s.tone}`}>{s.label}</span>
        {e.downloadable ? (
          <Button type="button" variant="quiet" onClick={onDownload}>
            <Download />
            Download
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** The page loaded with 428: ask once, then reload the server data. */
export function ConfirmToSee() {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Card>
      <div className="done">
        <span className="uv-icon-tile">
          <ShieldCheck />
        </span>
        <h2 className="auth__heading">Confirm it’s you to see your institution’s exports</h2>
        <p className="auth__sub">An export holds every record of your institution, so it’s only for IT Admins who have just confirmed who they are.</p>
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <Button
          onClick={() => {
            setError(null);
            withStepUp(() => unwrap(client.GET('/api/v1/exports')))
              .then((ok) => {
                if (ok) router.refresh();
              })
              .catch((err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, undefined, undefined)));
          }}
        >
          Confirm it’s me
        </Button>
      </div>
    </Card>
  );
}
