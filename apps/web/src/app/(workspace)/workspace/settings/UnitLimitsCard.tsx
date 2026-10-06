'use client';

import { messageFor, UnitLimits, type SettingView } from '@univarse/contracts';
import { Button, Card, Notice, Sliders } from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { useStepUp } from '@/components/StepUp';
import { api, ApiError } from '@/lib/client-api';

 
type View = SettingView<'registration.unitLimits'>;
type Draft = { min: string; max: string };
type FieldErrors = Partial<Record<keyof Draft, string>>;

const PATH = '/api/v1/settings/registration.unitLimits';
const RANGE_MAX = 60;
const etag = (v: View) => `"v${String(v.version)}"`;
const toDraft = (v: View): Draft => ({ min: String(v.value.min), max: String(v.value.max) });
const when = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });

/** Client check with the same schema the API uses (ST1). Whole numbers only; empty is not 0. */
function check(d: Draft): { value?: { min: number; max: number }; errors: FieldErrors } {
  const num = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);
  const r = UnitLimits.safeParse({ min: num(d.min), max: num(d.max) });
  if (r.success) return { value: r.data, errors: {} };
  const errors: FieldErrors = {};
  for (const i of r.error.issues) {
    const k = i.path[0];
    if ((k === 'min' || k === 'max') && !errors[k]) errors[k] = i.message;
  }
  return { errors };
}

/** The allowed range drawn on a 1–60 track (same language as the expiry bar). Words carry it too. */
function RangeBand({ min, max }: { min: number; max: number }) {
  const left = ((min - 1) / (RANGE_MAX - 1)) * 100;
  const width = Math.max(((max - min) / (RANGE_MAX - 1)) * 100, 1.5);
  return (
    <div className="band" aria-hidden="true">
      <div className="band__track">
        <span className="band__fill" style={{ left: `${String(left)}%`, width: `${String(width)}%` }} />
      </div>
      <div className="band__scale">
        <span>1</span>
        <span>{RANGE_MAX}</span>
      </div>
    </div>
  );
}

export function UnitLimitsCard({ initial }: { initial: View }) {
  const withStepUp = useStepUp();
  const titleId = useId();
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<Draft>(toDraft(initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const dirty = draft.min.trim() !== String(view.value.min) || draft.max.trim() !== String(view.value.max);
  const live = check(draft);
  const shown = live.value ?? view.value;
  const isDefault = view.source === 'default';

  const edit = (k: keyof Draft, v: string) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    setNotice(null);
    if (tried) setErrors(check(next).errors);
  };

  /** 412: someone else saved first. Show their values, keep nothing of ours (ST13). */
  async function reloadAfterConflict() {
    const latest = await api<View>('GET', PATH);
    setView(latest);
    setDraft(toDraft(latest));
    setErrors({});
    setTried(false);
    setNotice({ tone: 'info', text: messageFor('precondition.failed') });
  }

  async function run(kind: 'save' | 'reset', call: () => Promise<View>) {
    setBusy(kind);
    setFailure(null);
    setNotice(null);
    try {
      const next = await withStepUp(call);
      if (!next) return; // they closed "confirm it's you"
      setView(next);
      setDraft(toDraft(next));
      setTried(false);
      setConfirmReset(false);
      setNotice({
        tone: 'success',
        text:
          kind === 'reset'
            ? `Back to the default: ${String(next.value.min)} to ${String(next.value.max)} units per semester.`
            : `Saved: ${String(next.value.min)} to ${String(next.value.max)} units per semester.`,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, undefined, undefined);
      if (e.status === 412) {
        await reloadAfterConflict().catch(() => setFailure(e));
      } else if (e.status === 422 && e.fieldErrors.length > 0) {
        const fe: FieldErrors = {};
        for (const f of e.fieldErrors) if ((f.path === 'min' || f.path === 'max') && !fe[f.path]) fe[f.path] = f.message;
        setErrors(fe);
        setTried(true);
      } else setFailure(e);
    } finally {
      setBusy(null);
    }
  }

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTried(true);
    const r = check(draft);
    setErrors(r.errors);
    if (!r.value) {
      (r.errors.min ? minRef : maxRef).current?.focus();
      return;
    }
    const value = r.value;
    void run('save', () => api<View>('PUT', PATH, { value }, { ifMatch: etag(view) }));
  };

  const changedLine = isDefault
    ? view.updatedBy && view.updatedAt
      ? `Reset to the default by ${view.updatedBy.displayName} on ${when.format(new Date(view.updatedAt))}.`
      : 'Using the UniVarse default.'
    : view.updatedBy && view.updatedAt
      ? `Set by ${view.updatedBy.displayName} on ${when.format(new Date(view.updatedAt))}.`
      : 'Set by your institution.';

  return (
    <Card className="setting">
      <div className="setting__head">
        <span className="uv-icon-tile">
          <Sliders />
        </span>
        <div className="setting__heading">
          <div className="setting__titlerow">
            <h3 className="setting__title" id={titleId}>
              {view.label}
            </h3>
            <span className={isDefault ? 'status status--off' : 'status status--on'}>{isDefault ? 'Default' : 'Custom'}</span>
          </div>
          <p className="setting__about">The fewest and the most units a student may register for in one semester.</p>
        </div>
      </div>

      <p className="setting__summary">
        <span className="setting__figure">
          {shown.min}–{shown.max}
        </span>{' '}
        units per semester
      </p>
      <RangeBand min={shown.min} max={shown.max} />

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {failure ? <Notice requestId={failure.requestId}>{failure.message}</Notice> : null}

      {view.canManage ? (
        <form className="setting__form" noValidate onSubmit={onSubmit}>
          <div className="setting__fields">
            <TextField
              ref={minRef}
              label="Minimum units"
              name="min"
              inputMode="numeric"
              autoComplete="off"
              value={draft.min}
              onChange={(e) => edit('min', e.currentTarget.value)}
              hint={`Default ${String(view.default.min)}`}
              error={errors.min}
            />
            <TextField
              ref={maxRef}
              label="Maximum units"
              name="max"
              inputMode="numeric"
              autoComplete="off"
              value={draft.max}
              onChange={(e) => edit('max', e.currentTarget.value)}
              hint={`Default ${String(view.default.max)}`}
              error={errors.max}
            />
          </div>

          {confirmReset ? (
            <div className="setting__confirm" role="group" aria-label="Reset to default">
              <p>
                Go back to the default of {view.default.min} to {view.default.max} units?
              </p>
              <div className="row-actions">
                <Button
                  type="button"
                  variant="quiet"
                  pending={busy === 'reset'}
                  onClick={() => void run('reset', () => api<View>('DELETE', PATH, undefined, { ifMatch: etag(view) }))}
                >
                  Yes, reset
                </Button>
                <Button type="button" variant="plain" onClick={() => setConfirmReset(false)}>
                  Keep my values
                </Button>
              </div>
            </div>
          ) : (
            <div className="setting__actions">
              <Button type="submit" pending={busy === 'save'} disabled={!dirty || busy !== null}>
                Save changes
              </Button>
              {!isDefault ? (
                <Button type="button" variant="plain" disabled={busy !== null} onClick={() => setConfirmReset(true)}>
                  Reset to default
                </Button>
              ) : null}
            </div>
          )}
        </form>
      ) : (
        <p className="setting__readonly">Only staff who manage course registration settings can change these. Ask your Registrar.</p>
      )}

      <div className="setting__meta">
        <p>{changedLine}</p>
        <p>Course registration will use these limits once it opens in UniVarse. Nothing changes for students yet.</p>
      </div>
    </Card>
  );
}
