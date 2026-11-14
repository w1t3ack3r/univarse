'use client';

import type { PlatformNotice, PlatformNoticeDraft, PlatformTenantSummary } from '@univarse/contracts';
import { Button, Clock, Close, Megaphone, Notice } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useStepUp } from '../../components/step-up';
import { api, asApiError, type ApiError } from '../../lib/api';
import { fromLagosInput, NOTICE_KIND, NOTICE_PROBLEM, RING, toLagosInput } from '../../lib/notices';

type Kind = PlatformNoticeDraft['kind'];
type Audience = PlatformNoticeDraft['audience'];
type Ref = { id: string; slug: string; name: string };

const TITLE_MAX = 120;
const BODY_MAX = 2_000;

/**
 * Spec 0037 Q9 (T34): writing a notice. The preview beside the form is the banner exactly as an institution will see
 * it: plain text, line breaks kept, nothing turned into markup. Saving keeps a draft (it may be unfinished); publishing
 * checks it again on the platform, decides who gets it, and fixes it for good. Both ask for a step-up.
 */
export function NoticeEditor({ notice, onSaved }: { notice: PlatformNotice | null; onSaved?: (n: PlatformNotice) => void }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [kind, setKind] = useState<Kind>(notice?.kind ?? 'ANNOUNCEMENT');
  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [audience, setAudience] = useState<Audience>(notice?.audience ?? 'TENANTS');
  const [ring, setRing] = useState<'PILOT' | 'GENERAL'>(notice?.ring ?? 'PILOT');
  const [chosen, setChosen] = useState<Ref[]>(notice?.tenants ?? []);
  const [startsAt, setStartsAt] = useState(toLagosInput(notice?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLagosInput(notice?.endsAt ?? null));
  const [busy, setBusy] = useState<'save' | 'publish' | 'discard' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const draft = (): PlatformNoticeDraft => ({
    kind,
    title,
    body,
    audience,
    ...(audience === 'RING' ? { ring } : {}),
    ...(audience === 'TENANTS' ? { tenantIds: chosen.map((t) => t.id) } : {}),
    ...(kind === 'MAINTENANCE' ? { startsAt: fromLagosInput(startsAt), endsAt: fromLagosInput(endsAt) } : {}),
  });

  /** Saves the draft (new or edited) and returns it as stored. */
  const save = async (): Promise<PlatformNotice | undefined> =>
    stepUp(() => (notice ? api<PlatformNotice>('PUT', `/notices/${notice.id}`, draft(), { ifMatch: `"v${String(notice.version)}"` }) : api<PlatformNotice>('POST', '/notices', draft())));

  const run = (what: 'save' | 'publish' | 'discard') => {
    setBusy(what);
    setError(null);
    const go = async () => {
      if (what === 'discard') {
        if (notice && !(await stepUp(() => api<PlatformNotice>('POST', `/notices/${notice.id}/withdraw`)))) return;
        router.push('/notices');
        return;
      }
      const saved = await save();
      if (!saved) return;
      if (what === 'save') {
        if (!notice) router.replace(`/notices/${saved.id}`);
        else onSaved?.(saved);
        return;
      }
      const published = await stepUp(() => api<PlatformNotice>('POST', `/notices/${saved.id}/publish`, undefined, { ifMatch: `"v${String(saved.version)}"` }));
      if (published) {
        if (!notice) router.replace(`/notices/${published.id}`);
        else onSaved?.(published);
      } else if (!notice) router.replace(`/notices/${saved.id}`);
      else onSaved?.(saved);
    };
    go()
      .catch((err: unknown) => setError(asApiError(err)))
      .finally(() => setBusy(null));
  };

  const problems = notice?.problems ?? [];
  const fieldProblem = (path: string) => [...(error?.fieldErrors ?? []), ...problems].filter((p) => p.path === path).map((p) => NOTICE_PROBLEM[p.code] ?? p.code)[0];

  return (
    <div className="pc-notice-edit">
      <form
        method="post"
        className="pc-form pc-notice-edit__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          run('publish');
        }}
      >
        {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">What kind</legend>
          <div className="pc-seg pc-seg--choice">
            {(Object.keys(NOTICE_KIND) as Kind[]).map((k) => (
              <label key={k} className="pc-seg__opt" data-on={kind === k ? 'true' : undefined}>
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                {NOTICE_KIND[k].label}
              </label>
            ))}
          </div>
          <p className="pc-note">{NOTICE_KIND[kind].about}</p>
        </fieldset>

        <TextField label="Title" name="title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} hint={`${String(title.trim().length)} of ${String(TITLE_MAX)}`} error={fieldProblem('title')} required />

        <div className="uv-field">
          <label className="uv-field__label" htmlFor="notice-body">
            Message
          </label>
          <textarea id="notice-body" name="body" className="uv-field__input pc-textarea" rows={6} maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="notice-body-hint" required />
          <p id="notice-body-hint" className={fieldProblem('body') ? 'uv-field__error' : 'pc-note'}>
            {fieldProblem('body') ?? `Plain text: line breaks are kept, and a link shows as text. ${String(body.trim().length)} of 2,000.`}
          </p>
        </div>

        {kind === 'MAINTENANCE' ? (
          <fieldset className="pc-fieldset">
            <legend className="uv-field__label">When, in Nigerian time</legend>
            <div className="pc-notice-edit__window">
              <TextField label="Starts" type="datetime-local" name="startsAt" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} error={fieldProblem('startsAt')} />
              <TextField label="Ends" type="datetime-local" name="endsAt" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} error={fieldProblem('endsAt')} />
            </div>
          </fieldset>
        ) : null}

        <fieldset className="pc-fieldset">
          <legend className="uv-field__label">Who gets it</legend>
          <div className="pc-choices">
            {(
              [
                ['TENANTS', 'Chosen institutions', 'Pick them below.'],
                ['RING', 'A release ring', 'Every institution in the ring when it’s published.'],
                ['ALL', 'Every institution', 'Every institution with people, suspended ones too.'],
              ] as const
            ).map(([value, label, about]) => (
              <label key={value} className="pc-check">
                <input type="radio" name="audience" value={value} checked={audience === value} onChange={() => setAudience(value)} />
                <span>
                  <strong>{label}</strong>
                  <span className="pc-note">{about}</span>
                </span>
              </label>
            ))}
          </div>
          {audience === 'RING' ? (
            <div className="pc-seg pc-seg--choice" role="radiogroup" aria-label="Ring">
              {(['PILOT', 'GENERAL'] as const).map((r) => (
                <label key={r} className="pc-seg__opt" data-on={ring === r ? 'true' : undefined}>
                  <input type="radio" name="ring" value={r} checked={ring === r} onChange={() => setRing(r)} />
                  {RING[r].label}
                </label>
              ))}
            </div>
          ) : null}
          {audience === 'TENANTS' ? <ChooseInstitutions chosen={chosen} onChange={setChosen} problem={fieldProblem('tenantIds')} /> : null}
          {audience === 'ALL' ? <p className="pc-note pc-notice-edit__wide">It reaches every institution at once. Check the preview before you publish.</p> : null}
        </fieldset>

        <div className="pc-row-actions pc-row-actions--start pc-row-actions--wrap">
          <Button type="submit" pending={busy === 'publish'} disabled={busy !== null}>
            Publish
          </Button>
          <Button type="button" variant="quiet" pending={busy === 'save'} disabled={busy !== null} onClick={() => run('save')}>
            Save the draft
          </Button>
          {notice ? (
            <Button type="button" variant="plain" className="pc-danger" pending={busy === 'discard'} disabled={busy !== null} onClick={() => run('discard')}>
              Discard
            </Button>
          ) : null}
        </div>
        <p className="pc-note">Once published, a notice never changes. To correct one, publish a new notice and withdraw the old.</p>
      </form>

      <aside className="pc-notice-edit__preview" aria-labelledby="preview-title">
        <h2 id="preview-title" className="pc-subhead">
          As an institution sees it
        </h2>
        <BannerPreview kind={kind} title={title} body={body} startsAt={fromLagosInput(startsAt)} endsAt={fromLagosInput(endsAt)} />
      </aside>
    </div>
  );
}

const day = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const time = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });

/** The banner, as the web app draws it: text nodes only, so markup in a notice shows as the characters it is. */
export function BannerPreview({ kind, title, body, startsAt, endsAt }: { kind: Kind; title: string; body: string; startsAt: string | null; endsAt: string | null }) {
  const window = startsAt && endsAt ? `${day.format(new Date(startsAt))}, ${time.format(new Date(startsAt))} to ${time.format(new Date(endsAt))}` : null;
  return (
    <div className={`pc-banner pc-banner--${kind.toLowerCase()}`}>
      <span className="pc-banner__icon" aria-hidden="true">
        {kind === 'MAINTENANCE' ? <Clock size={18} /> : <Megaphone size={18} />}
      </span>
      <div className="pc-banner__text">
        <p className="pc-banner__kind">{NOTICE_KIND[kind].banner}</p>
        <p className="pc-banner__title">{title.trim() || 'Your title'}</p>
        {kind === 'MAINTENANCE' && window ? <p className="pc-banner__window">{window}, Nigerian time</p> : null}
        <p className="pc-banner__body">{body.trim() || 'Your message.'}</p>
      </div>
    </div>
  );
}

/** Spec 0037 Q9: up to 200 institutions, found by name or subdomain. */
export function ChooseInstitutions({ chosen, onChange, problem }: { chosen: Ref[]; onChange: (r: Ref[]) => void; problem: string | undefined }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PlatformTenantSummary[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ data: PlatformTenantSummary[] }>('GET', `/tenants?q=${encodeURIComponent(term)}&limit=8`)
        .then((r) => setFound(r.data))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const has = new Set(chosen.map((c) => c.id));
  return (
    <div className="pc-notice-edit__choose">
      <div className="uv-field">
        <label className="uv-field__label" htmlFor="notice-find">
          Add an institution
        </label>
        <input id="notice-find" type="search" className="uv-field__input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or subdomain" autoComplete="off" />
        {problem ? <p className="uv-field__error">{problem}</p> : null}
      </div>
      {found.length ? (
        <ul className="pc-notice-edit__found" aria-label="Matching institutions">
          {found.map((t) => (
            <li key={t.id}>
              <span>
                {t.shortName} <span className="pc-note">{t.slug}</span>
              </span>
              <Button type="button" variant="plain" disabled={has.has(t.id)} onClick={() => onChange([...chosen, { id: t.id, slug: t.slug, name: t.shortName }])}>
                {has.has(t.id) ? 'Added' : `Add ${t.shortName}`}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {chosen.length ? (
        <ul className="pc-chips" aria-label="Chosen institutions">
          {chosen.map((t) => (
            <li key={t.id} className="pc-chip">
              {t.name}
              <button type="button" className="pc-chip__remove" aria-label={`Remove ${t.name}`} onClick={() => onChange(chosen.filter((c) => c.id !== t.id))}>
                <Close size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pc-note">None chosen yet.</p>
      )}
    </div>
  );
}
