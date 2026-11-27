'use client';

import {
  ArrowLeft,
  Archive,
  Button,
  ChevronDown,
  History,
  Lock,
  Move,
  Notice,
  Pause,
  Pencil,
  Plus,
  Refresh,
} from '@univarse/ui';
import { SelectField, TextAreaField, TextField } from '@univarse/ui/client';
import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { allowedChildTypes, ancestorsOf, moveTargets, subtreeIds, type Tree } from './tree';
import {
  CHANGE_WORD,
  longDay,
  plural,
  STATE_WORD,
  today,
  type Change,
  type UnitType,
  type UnitView,
} from './words';

export type Mode =
  | { kind: 'view' }
  | { kind: 'add' }
  | { kind: 'edit' }
  | { kind: 'move'; to?: string }
  | { kind: 'deactivate' }
  | { kind: 'archive' }
  | { kind: 'reactivate' }
  | { kind: 'code' };

interface Props {
  id: string;
  tree: Tree;
  types: UnitType[];
  mode: Mode;
  setMode: (m: Mode) => void;
  readOnly: boolean;
  onChoose: (id: string, m?: Mode) => void;
  onClose: () => void;
  /** After a change: the page reloads the tree; a new unit is chosen, and shown with `message`. */
  onChanged: (createdId?: string, message?: string) => void;
  /** A message carried over from the panel that made this unit. */
  flash?: string | null | undefined;
}

const ifMatch = (v: UnitView) => ({ 'If-Match': `"v${String(v.version)}"` });
const asError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, undefined, undefined);

/** Codes a form shows beside its field rather than above it. */
const CODE_FIELD = new Set(['org.unit.code_invalid', 'org.unit.code_taken', 'org.unit.same_code']);
const DATE_FIELD = new Set([
  'org.unit.effective_date_invalid',
  'org.unit.effective_date_future',
  'org.unit.effective_date_out_of_order',
]);

/** Spec 0042: one unit, in the panel beside the chart. Every change is made here, never on the chart itself. */
export function UnitPanel({
  id,
  tree,
  types,
  mode,
  setMode,
  readOnly,
  onChoose,
  onClose,
  onChanged,
  flash,
}: Props) {
  const [view, setView] = useState<UnitView | null>(null);
  const [history, setHistory] = useState<Change[] | null>(null);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(flash ?? null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listed = tree.byId.get(id);

  const load = async () => {
    try {
      const [v, h] = await Promise.all([
        unwrap(client.GET('/api/v1/org/units/{id}', { params: { path: { id } } })),
        unwrap(client.GET('/api/v1/org/units/{id}/history', { params: { path: { id } } })),
      ]);
      setView(v);
      setHistory(h.data);
      setFailed(null);
    } catch (err) {
      setFailed(asError(err));
    }
  };

  useEffect(() => {
    void load();
    heading.current?.focus();
    // Under 1100px the panel takes the chart's place: bring its top into view.
    if (!window.matchMedia('(min-width: 1100px)').matches)
      root.current?.scrollIntoView({ block: 'start' });
    // Loaded once per unit (the panel is keyed by it); a change reloads it explicitly.
  }, [id]);

  const finished = (message: string, createdId?: string) => {
    setMode({ kind: 'view' });
    onChanged(createdId, message);
    if (createdId) return; // the new unit's own panel shows the message
    setDone(message);
    void load();
  };

  const back = (
    <button type="button" className="org-panel__back" onClick={onClose}>
      <ArrowLeft size={20} />
      Back to the structure
    </button>
  );

  if (failed && !view) {
    return (
      <div className="org-panel">
        {back}
        <Notice requestId={failed.requestId}>
          {failed.status === 404
            ? 'This unit isn’t there any more, or isn’t yours to see.'
            : failed.message}
        </Notice>
      </div>
    );
  }
  if (!view || !listed) {
    return (
      <div className="org-panel" aria-busy="true">
        {back}
        <h2 className="org-panel__title" ref={heading} tabIndex={-1}>
          {listed?.name ?? 'Loading the unit'}
        </h2>
        <div className="org-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  const isRoot = view.parentId === null;
  const form = (() => {
    const common = {
      view,
      onCancel: () => setMode({ kind: 'view' }),
      onDone: finished,
      onStale: () => void load(),
    };
    switch (mode.kind) {
      case 'add':
        return <AddForm {...common} tree={tree} types={types} />;
      case 'edit':
        return <EditForm {...common} tree={tree} types={types} />;
      case 'move':
        return <MoveForm {...common} tree={tree} types={types} to={mode.to} />;
      case 'deactivate':
      case 'reactivate':
      case 'archive':
        return <StateForm {...common} kind={mode.kind} />;
      case 'code':
        return <CodeForm {...common} />;
      case 'view':
        return null;
    }
  })();

  const canAdd =
    view.can.manage && view.state === 'ACTIVE' && allowedChildTypes(listed, types).length > 0;
  return (
    <div className="org-panel" ref={root}>
      {back}
      {view.ancestors.length > 0 ? (
        <nav aria-label="Where it sits" className="org-panel__path">
          <ol>
            {view.ancestors.map((a) => (
              <li key={a.id}>
                {tree.byId.has(a.id) ? (
                  <button type="button" className="org-panel__crumb" onClick={() => onChoose(a.id)}>
                    {a.name}
                  </button>
                ) : (
                  <span>{a.name}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <h2 className="org-panel__title" ref={heading} tabIndex={-1}>
        {view.name}
      </h2>
      <p className="org-panel__kind">
        {view.type ? view.type.name : 'The institution'}
        {view.code ? <span className="org-panel__code">{view.code}</span> : null}
        {view.state !== 'ACTIVE' ? (
          <span
            className={`status ${view.state === 'ARCHIVED' ? 'status--archived' : 'status--off'}`}
          >
            {view.state === 'ARCHIVED' ? <Archive size={14} /> : <Pause size={14} />}
            {STATE_WORD[view.state]}
          </span>
        ) : null}
        {view.codeLocked ? (
          <span className="status status--off">
            <Lock size={14} />
            Code on issued numbers
          </span>
        ) : null}
      </p>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {failed ? <Notice requestId={failed.requestId}>{failed.message}</Notice> : null}
      {!view.followsRules ? (
        <Notice tone="info">
          Its type no longer fits under the unit above it. It stays where it is until it’s moved or
          given another type.
        </Notice>
      ) : null}

      {form ?? (
        <>
          {view.description ? <p className="org-panel__about">{view.description}</p> : null}
          <dl className="org-facts">
            <div>
              <dt>Status</dt>
              <dd>
                {STATE_WORD[view.state]}
                {!isRoot && !view.code ? ', no code yet' : ''}
              </dd>
            </div>
            <div>
              <dt>Inside it</dt>
              <dd>
                {view.children.open === 0 && view.children.archived === 0
                  ? 'No units'
                  : `${plural(view.children.open, 'unit')}${view.children.archived ? `, and ${String(view.children.archived)} archived` : ''}`}
              </dd>
            </div>
            <div>
              <dt>In the structure since</dt>
              <dd>{longDay(view.createdOn)}</dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>{longDay(view.lastChangedOn)}</dd>
            </div>
          </dl>
          {!readOnly ? (
            <div className="org-actions">
              {view.can.manage && !isRoot ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'edit' })}>
                  <Pencil size={18} />
                  Edit details
                </Button>
              ) : null}
              {canAdd ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'add' })}>
                  <Plus size={18} />
                  Add a unit inside
                </Button>
              ) : null}
              {view.can.restructure && !isRoot && view.state !== 'ARCHIVED' ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'move' })}>
                  <Move size={18} />
                  Move unit
                </Button>
              ) : null}
              {view.can.restructure && view.codeLocked && !isRoot ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'code' })}>
                  <Lock size={18} />
                  Give it a new code
                </Button>
              ) : null}
            </div>
          ) : null}
          {!readOnly && !isRoot && (view.can.manage || view.can.restructure) ? (
            <div className="org-actions org-actions--state">
              {view.can.manage && view.state === 'ACTIVE' ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'deactivate' })}>
                  <Pause size={18} />
                  Deactivate
                </Button>
              ) : null}
              {view.state !== 'ACTIVE' &&
              (view.state === 'INACTIVE' ? view.can.manage : view.can.restructure) ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'reactivate' })}>
                  <Refresh size={18} />
                  Reactivate
                </Button>
              ) : null}
              {view.can.restructure && view.state !== 'ARCHIVED' ? (
                <Button variant="quiet" onClick={() => setMode({ kind: 'archive' })}>
                  <Archive size={18} />
                  Archive
                </Button>
              ) : null}
            </div>
          ) : null}
          <HistoryList history={history} tree={tree} />
        </>
      )}
    </div>
  );
}

function HistoryList({ history, tree }: { history: Change[] | null; tree: Tree }) {
  return (
    <details className="disclosure org-history" open>
      <summary>
        <History size={18} />
        <span className="org-history__title">History</span>
        <ChevronDown size={18} />
      </summary>
      {history === null ? (
        <p className="org-history__empty">Loading…</p>
      ) : (
        <ol className="org-history__list">
          {history.map((c) => (
            <li key={c.id}>
              <span className="org-history__day">{longDay(c.effectiveFrom)}</span>
              <span className="org-history__what">
                {CHANGE_WORD[c.kind]}
                {c.kind === 'RENAMED' ? `: now “${c.name}”` : ''}
                {(c.kind === 'CODE_CHANGED' || c.kind === 'CODE_CORRECTED') && c.code
                  ? `: now ${c.code}`
                  : ''}
                {c.kind === 'MOVED' && c.parentId
                  ? `: now under ${tree.byId.get(c.parentId)?.name ?? 'another unit'}`
                  : ''}
              </span>
              <span className="org-history__who">
                {c.actor ? `By ${c.actor.displayName}` : 'By UniVarse'}
              </span>
              {c.reason ? <span className="org-history__why">“{c.reason}”</span> : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

// ─── Forms. Each is the panel's one task: its submit is the page's one lime action.

interface FormProps {
  view: UnitView;
  onCancel: () => void;
  onDone: (message: string, createdId?: string) => void;
  onStale: () => void;
}

/** The shared frame: heading, a problem above, fields, the action and Cancel. */
function useFormState(onStale: () => void) {
  const withStepUp = useStepUp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const field = (codes: Set<string>) =>
    error?.code && codes.has(error.code) ? error.message : undefined;
  const run = async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await withStepUp(call);
    } catch (err) {
      const e = asError(err);
      setError(e);
      if (e.status === 412) onStale();
      return undefined;
    } finally {
      setPending(false);
    }
  };
  const top =
    error && !CODE_FIELD.has(error.code ?? '') && !DATE_FIELD.has(error.code ?? '') ? (
      <Notice requestId={error.requestId}>{error.message}</Notice>
    ) : null;
  return { pending, run, field, top };
}

function Frame({
  title,
  lede,
  top,
  children,
  submit,
  pending,
  onCancel,
  onSubmit,
  disabled,
}: {
  title: string;
  lede?: ReactNode;
  top: ReactNode;
  children: ReactNode;
  submit: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (e: SubmitEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <form method="post" className="org-form" onSubmit={onSubmit} noValidate>
      <h3 className="org-form__title" ref={heading} tabIndex={-1}>
        {title}
      </h3>
      {lede ? <p className="org-form__lede">{lede}</p> : null}
      {top}
      {children}
      <div className="org-form__actions">
        <Button type="submit" pending={pending} disabled={disabled}>
          {submit}
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function DateField({ error, hint }: { error?: string | undefined; hint?: string }) {
  return (
    <TextField
      label="Takes effect"
      name="effectiveFrom"
      type="date"
      defaultValue={today()}
      max={today()}
      required
      hint={hint ?? 'Today, or the day it really happened. Never a later day.'}
      error={error}
    />
  );
}

function AddForm({
  view,
  tree,
  types,
  onCancel,
  onDone,
  onStale,
}: FormProps & { tree: Tree; types: UnitType[] }) {
  const parent = tree.byId.get(view.id);
  const allowed = parent ? allowedChildTypes(parent, types) : [];
  const key = useRef(crypto.randomUUID());
  const { pending, run, field, top } = useFormState(onStale);
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const code = text(f, 'code');
    const description = text(f, 'description');
    void run(() =>
      unwrap(
        client.POST('/api/v1/org/units', {
          body: {
            parentId: view.id,
            typeId: text(f, 'typeId'),
            name: text(f, 'name'),
            ...(code ? { code } : {}),
            ...(description ? { description } : {}),
            effectiveFrom: text(f, 'effectiveFrom'),
          },
          headers: { 'idempotency-key': key.current },
        }),
      ),
    ).then((made) => {
      if (made) onDone(`${made.name} was added to ${view.name}.`, made.id);
    });
  };
  return (
    <Frame
      title={`Add a unit to ${view.name}`}
      top={top}
      submit="Add the unit"
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
    >
      <SelectField
        label="Type"
        name="typeId"
        required
        defaultValue={allowed[0]?.id}
        hint={`What ${view.parentId === null ? 'the institution' : `a ${view.type?.name.toLowerCase() ?? 'unit'}`} may hold.`}
      >
        {allowed.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </SelectField>
      <TextField label="Name" name="name" required maxLength={120} autoComplete="off" />
      <TextField
        label="Code"
        name="code"
        maxLength={12}
        autoComplete="off"
        hint="Like CSC or SICT: 2 to 12 letters and digits. Leave it empty if it isn’t decided yet."
        error={field(CODE_FIELD)}
        className="org-form__code"
      />
      <TextAreaField label="Description (optional)" name="description" maxLength={500} rows={3} />
      <DateField
        error={field(DATE_FIELD)}
        hint="Today, or the day the unit was founded. Never a later day."
      />
    </Frame>
  );
}

function EditForm({
  view,
  tree,
  types,
  onCancel,
  onDone,
  onStale,
}: FormProps & { tree: Tree; types: UnitType[] }) {
  const { pending, run, field, top } = useFormState(onStale);
  const parent = view.parentId ? tree.byId.get(view.parentId) : undefined;
  // A new type keeps the kind and fits under the parent (Q10); the API checks the children too.
  const retypes =
    view.can.restructure && parent && view.type
      ? allowedChildTypes(parent, types).filter((t) => t.kind === view.type?.kind)
      : [];
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = text(f, 'name');
    const description = text(f, 'description');
    const code = text(f, 'code').toUpperCase();
    const typeId = text(f, 'typeId');
    const body = {
      ...(name !== view.name ? { name } : {}),
      ...(description !== (view.description ?? '') ? { description: description || null } : {}),
      ...(!view.codeLocked && code !== (view.code ?? '') ? { code: code || null } : {}),
      ...(typeId && typeId !== view.type?.id ? { typeId } : {}),
      effectiveFrom: text(f, 'effectiveFrom'),
    };
    if (Object.keys(body).length === 1) {
      onCancel();
      return;
    }
    void run(() =>
      unwrap(
        client.PATCH('/api/v1/org/units/{id}', {
          params: { path: { id: view.id }, header: ifMatch(view) },
          body,
        }),
      ),
    ).then((v) => {
      if (v) onDone('Saved.');
    });
  };
  return (
    <Frame
      title={`Edit ${view.name}`}
      top={top}
      submit="Save changes"
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
    >
      <TextField
        label="Name"
        name="name"
        required
        maxLength={120}
        defaultValue={view.name}
        autoComplete="off"
      />
      <TextField
        label="Code"
        name="code"
        maxLength={12}
        defaultValue={view.code ?? ''}
        autoComplete="off"
        disabled={view.codeLocked}
        className="org-form__code"
        hint={
          view.codeLocked
            ? 'This code is on issued matric numbers, so it can’t be corrected. Use “Give it a new code” instead.'
            : 'Correcting a code frees the old one for another unit.'
        }
        error={field(CODE_FIELD)}
      />
      {retypes.length > 1 ? (
        <SelectField
          label="Type"
          name="typeId"
          defaultValue={view.type?.id}
          hint="Only types of the same kind that fit where it sits."
        >
          {retypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextAreaField
        label="Description (optional)"
        name="description"
        maxLength={500}
        rows={3}
        defaultValue={view.description ?? ''}
      />
      <DateField error={field(DATE_FIELD)} />
    </Frame>
  );
}

function MoveForm({
  view,
  tree,
  types,
  to,
  onCancel,
  onDone,
  onStale,
}: FormProps & { tree: Tree; types: UnitType[]; to: string | undefined }) {
  const { pending, run, field, top } = useFormState(onStale);
  const unit = tree.byId.get(view.id);
  const targets = unit ? moveTargets(tree, unit, types) : [];
  const [filter, setFilter] = useState('');
  const [choice, setChoice] = useState<string | undefined>(
    to && targets.some((t) => t.id === to) ? to : undefined,
  );
  const moving = subtreeIds(tree, view.id).size;
  const from = view.ancestors.at(-1);
  const pathOf = (id: string) =>
    ancestorsOf(tree, id)
      .map((a) => a.name)
      .join(' › ');
  const shown = targets.filter(
    (t) =>
      !filter.trim() ||
      `${t.name} ${t.code ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const chosen = choice ? tree.byId.get(choice) : undefined;
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!choice) return;
    const f = new FormData(e.currentTarget);
    void run(() =>
      unwrap(
        client.POST('/api/v1/org/units/{id}/move', {
          params: { path: { id: view.id }, header: ifMatch(view) },
          body: {
            parentId: choice,
            reason: text(f, 'reason'),
            effectiveFrom: text(f, 'effectiveFrom'),
          },
        }),
      ),
    ).then((v) => {
      if (v) onDone(`${view.name} now sits under ${chosen?.name ?? 'its new unit'}.`);
    });
  };
  return (
    <Frame
      title={`Move ${view.name}`}
      lede={
        <>
          {moving > 1
            ? `${plural(moving - 1, 'unit')} inside it ${moving - 1 === 1 ? 'moves' : 'move'} with it. `
            : ''}
          Anyone whose role is given on {from?.name ?? 'the unit above it'} stops covering it once
          it moves.
        </>
      }
      top={top}
      submit={chosen ? `Move it under ${chosen.name}` : 'Move it'}
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
      disabled={!choice}
    >
      {targets.length === 0 ? (
        <Notice tone="info">
          There’s no unit it can move under: none active of a type that may hold a{' '}
          {view.type?.name.toLowerCase() ?? 'unit'}.
        </Notice>
      ) : (
        <fieldset className="org-pick">
          <legend className="uv-field__label">Move it under</legend>
          {targets.length > 6 ? (
            <TextField
              label="Find the unit"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
            />
          ) : null}
          <ul className="org-pick__list">
            {shown.map((t) => (
              <li key={t.id}>
                <label
                  className={`org-pick__option${t.id === choice ? ' org-pick__option--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="parentId"
                    value={t.id}
                    checked={t.id === choice}
                    onChange={() => setChoice(t.id)}
                  />
                  <span>
                    <span className="org-pick__name">{t.name}</span>
                    <span className="org-pick__path">
                      {t.parentId === null ? 'The institution itself' : pathOf(t.id)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {shown.length === 0 ? <li className="org-pick__none">No unit matches.</li> : null}
          </ul>
        </fieldset>
      )}
      <TextAreaField
        label="Why it’s moving"
        name="reason"
        required
        maxLength={500}
        rows={2}
        hint="Kept in its history, for whoever asks later."
      />
      <DateField error={field(DATE_FIELD)} />
    </Frame>
  );
}

function StateForm({
  view,
  kind,
  onCancel,
  onDone,
  onStale,
}: FormProps & { kind: 'deactivate' | 'reactivate' | 'archive' }) {
  const { pending, run, field, top } = useFormState(onStale);
  const blocked = kind === 'archive' && view.children.open > 0;
  const words = {
    deactivate: {
      title: `Deactivate ${view.name}`,
      lede: 'It stays in the structure and keeps everything inside it, but takes no new unit until it’s reactivated.',
      submit: 'Deactivate it',
      done: `${view.name} is inactive.`,
    },
    reactivate: {
      title: `Reactivate ${view.name}`,
      lede: 'It becomes active again, and can take new units.',
      submit: 'Reactivate it',
      done: `${view.name} is active again.`,
    },
    archive: {
      title: `Archive ${view.name}`,
      lede: blocked
        ? `Archive the ${plural(view.children.open, 'unit')} inside it first: a unit is archived only once everything inside it is.`
        : 'It leaves the structure you see every day, with its history kept. Nothing is ever deleted, and it can be reactivated.',
      submit: 'Archive it',
      done: `${view.name} is archived.`,
    },
  }[kind];
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = text(f, 'reason');
    const body = { effectiveFrom: text(f, 'effectiveFrom'), ...(reason ? { reason } : {}) };
    const opts = { params: { path: { id: view.id }, header: ifMatch(view) } };
    const call =
      kind === 'deactivate'
        ? () => unwrap(client.POST('/api/v1/org/units/{id}/deactivate', { ...opts, body }))
        : kind === 'reactivate'
          ? () => unwrap(client.POST('/api/v1/org/units/{id}/reactivate', { ...opts, body }))
          : () =>
              unwrap(
                client.POST('/api/v1/org/units/{id}/archive', {
                  ...opts,
                  body: { ...body, reason },
                }),
              );
    void run(call).then((v) => {
      if (v) onDone(words.done);
    });
  };
  return (
    <Frame
      title={words.title}
      lede={words.lede}
      top={top}
      submit={words.submit}
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
      disabled={blocked}
    >
      {blocked ? null : (
        <>
          <TextAreaField
            label={kind === 'archive' ? 'Why it’s being archived' : 'Why (optional)'}
            name="reason"
            required={kind === 'archive'}
            maxLength={500}
            rows={2}
          />
          <DateField error={field(DATE_FIELD)} />
        </>
      )}
    </Frame>
  );
}

function CodeForm({ view, onCancel, onDone, onStale }: FormProps) {
  const { pending, run, field, top } = useFormState(onStale);
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(() =>
      unwrap(
        client.POST('/api/v1/org/units/{id}/code', {
          params: { path: { id: view.id }, header: ifMatch(view) },
          body: {
            code: text(f, 'code'),
            reason: text(f, 'reason'),
            effectiveFrom: text(f, 'effectiveFrom'),
          },
        }),
      ),
    ).then((v) => {
      if (v)
        onDone(
          `${view.name}’s code is now ${v.code ?? ''}. Numbers already issued keep ${view.code ?? 'the old one'}.`,
        );
    });
  };
  return (
    <Frame
      title={`Give ${view.name} a new code`}
      lede={`${view.code ?? 'Its code'} is on matric numbers already issued, and those never change. The new code is used from the day it takes effect; ${view.code ?? 'the old one'} stays reserved for this unit.`}
      top={top}
      submit="Change the code"
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
    >
      <TextField
        label="New code"
        name="code"
        required
        maxLength={12}
        autoComplete="off"
        className="org-form__code"
        error={field(CODE_FIELD)}
      />
      <TextAreaField
        label="Why the code is changing"
        name="reason"
        required
        maxLength={500}
        rows={2}
      />
      <DateField error={field(DATE_FIELD)} />
    </Frame>
  );
}
