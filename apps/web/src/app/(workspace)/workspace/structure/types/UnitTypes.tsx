'use client';

import { Archive, Button, Card, Notice, Pencil, Plus } from '@univarse/ui';
import { SelectField, TextField } from '@univarse/ui/client';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useStepUp } from '@/components/StepUp';
import { ApiError, client, unwrap } from '@/lib/client-api';
import { KIND_WORD, plural, type UnitType } from '../words';

/**
 * Q2: a new type's key, made once from its first name, unique among the keys in use (the same rule as the domain's
 * `typeKeyFromName`; the API checks the format, and a key someone took meanwhile answers as a stale version).
 */
function keyFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'type';
  const start = /^[a-z]/.test(base) ? base : `type_${base}`.slice(0, 32);
  let key = start.length >= 2 ? start : `${start}_type`;
  for (let n = 2; taken.has(key); n += 1) key = `${start}_${String(n)}`;
  return key;
}

const NEW = ' new';
const field = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const asError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, undefined, undefined);

export function UnitTypes({ initial, canManage }: { initial: UnitType[]; canManage: boolean }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [types, setTypes] = useState(initial);
  /** The key of the type being edited, `NEW` for the new type's form, or null. */
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const nameOf = new Map(types.map((t) => [t.key, t.name]));

  const save = async (
    key: string,
    version: number,
    body: {
      name: string;
      kind: UnitType['kind'];
      status: UnitType['status'];
      mayContain: string[];
    },
    message: string,
  ) => {
    setPending(true);
    setError(null);
    try {
      const saved = await withStepUp(() =>
        unwrap(
          client.PUT('/api/v1/org/unit-types/{key}', {
            params: { path: { key }, header: { 'If-Match': `"v${String(version)}"` } },
            body,
          }),
        ),
      );
      if (saved) {
        setTypes((all) =>
          all.some((t) => t.key === saved.key)
            ? all.map((t) => (t.key === saved.key ? saved : t))
            : [...all, saved],
        );
        setEditing(null);
        setDone(message);
        router.refresh();
      }
    } catch (err) {
      const e = asError(err);
      setError(e);
      if (e.status === 412) router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {done ? <Notice tone="success">{done}</Notice> : null}
      <Card>
        <ul className="list types">
          {types.map((t) =>
            editing === t.key ? (
              <li key={t.key} className="types__row types__row--editing">
                <TypeEditor
                  type={t}
                  all={types}
                  pending={pending}
                  error={error}
                  onCancel={() => {
                    setEditing(null);
                    setError(null);
                  }}
                  onSave={(body) => void save(t.key, t.version, body, `${body.name} is saved.`)}
                />
              </li>
            ) : (
              <li
                key={t.key}
                className={`list__row types__row${t.status === 'ARCHIVED' ? ' types__row--archived' : ''}`}
              >
                <span className="list__text">
                  <span className="list__title">{t.name}</span>
                  <span className="list__meta">
                    {KIND_WORD[t.kind]} · {t.units === 0 ? 'No units yet' : plural(t.units, 'unit')}
                  </span>
                  <span className="types__holds">
                    {t.mayContain.length === 0
                      ? 'Holds no other units'
                      : `May hold: ${t.mayContain.map((k) => nameOf.get(k) ?? k).join(', ')}`}
                  </span>
                </span>
                {t.status === 'ARCHIVED' ? (
                  <span className="status status--archived">
                    <Archive size={14} />
                    Archived
                  </span>
                ) : null}
                {canManage ? (
                  <Button
                    variant="quiet"
                    className="types__edit"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => {
                      setEditing(t.key);
                      setDone(null);
                      setError(null);
                    }}
                  >
                    <Pencil size={18} />
                    Edit
                  </Button>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </Card>
      {canManage ? (
        editing === NEW ? (
          <Card>
            <NewType
              taken={new Set(types.map((t) => t.key))}
              names={new Set(types.map((t) => t.name.toLowerCase()))}
              pending={pending}
              error={error}
              onCancel={() => {
                setEditing(null);
                setError(null);
              }}
              onSave={(key, name, kind) =>
                void save(
                  key,
                  0,
                  { name, kind, status: 'ACTIVE', mayContain: [] },
                  `${name} is added. Choose what it may hold, and which types may hold it.`,
                )
              }
            />
          </Card>
        ) : (
          <div>
            <Button
              variant={editing ? 'quiet' : 'action'}
              onClick={() => {
                setEditing(NEW);
                setDone(null);
                setError(null);
              }}
            >
              <Plus size={20} />
              Add a unit type
            </Button>
          </div>
        )
      ) : (
        <p className="types__note">Your IT Admin or Registrar can change these.</p>
      )}
    </>
  );
}

function TypeEditor({
  type,
  all,
  pending,
  error,
  onCancel,
  onSave,
}: {
  type: UnitType;
  all: UnitType[];
  pending: boolean;
  error: ApiError | null;
  onCancel: () => void;
  onSave: (body: {
    name: string;
    kind: UnitType['kind'];
    status: UnitType['status'];
    mayContain: string[];
  }) => void;
}) {
  const [holds, setHolds] = useState(new Set(type.mayContain));
  const [archived, setArchived] = useState(type.status === 'ARCHIVED');
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = field(new FormData(e.currentTarget), 'name');
    onSave({
      name,
      kind: type.kind,
      status: archived ? 'ARCHIVED' : 'ACTIVE',
      mayContain: [...holds].sort(),
    });
  };
  return (
    <form method="post" className="org-form" onSubmit={onSubmit} noValidate>
      <h2 className="org-form__title">Edit {type.name}</h2>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <TextField
        label="Name"
        name="name"
        defaultValue={type.name}
        required
        maxLength={60}
        hint={`Your institution’s word for it. Its kind (${KIND_WORD[type.kind].toLowerCase()}) stays as it is.`}
      />
      <fieldset className="types__holds-set">
        <legend className="uv-field__label">May hold</legend>
        <p className="uv-field__hint">
          Units of these types can sit inside a {type.name.toLowerCase()}.
        </p>
        <div className="types__checks">
          {all.map((t) => (
            <label key={t.key} className="check">
              <input
                type="checkbox"
                checked={holds.has(t.key)}
                onChange={(e) =>
                  setHolds((was) => {
                    const next = new Set(was);
                    if (e.target.checked) next.add(t.key);
                    else next.delete(t.key);
                    return next;
                  })
                }
              />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        role="switch"
        aria-checked={archived}
        className="switch"
        onClick={() => setArchived((a) => !a)}
      >
        <span className="switch__track">
          <span className="switch__thumb" />
        </span>
        <span className="switch__text">
          {archived
            ? 'Archived: no new units of this type'
            : 'In use: new units can have this type'}
        </span>
      </button>
      <div className="org-form__actions">
        <Button type="submit" pending={pending}>
          Save changes
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewType({
  taken,
  names,
  pending,
  error,
  onCancel,
  onSave,
}: {
  taken: ReadonlySet<string>;
  names: ReadonlySet<string>;
  pending: boolean;
  error: ApiError | null;
  onCancel: () => void;
  onSave: (key: string, name: string, kind: UnitType['kind']) => void;
}) {
  const [nameError, setNameError] = useState<string | undefined>();
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = field(f, 'name');
    const kind = (field(f, 'kind') || 'ACADEMIC') as UnitType['kind'];
    if (!name) {
      setNameError('Give the type a name.');
      return;
    }
    if (names.has(name.toLowerCase())) {
      setNameError('Another unit type already has that name.');
      return;
    }
    setNameError(undefined);
    onSave(keyFor(name, taken), name, kind);
  };
  return (
    <form method="post" className="org-form" onSubmit={onSubmit} noValidate>
      <h2 className="org-form__title">Add a unit type</h2>
      {error ? <Notice requestId={error.requestId}>{error.message}</Notice> : null}
      <TextField
        label="Name"
        name="name"
        required
        maxLength={60}
        hint="Like “Teaching Hospital” or “Programme Office”."
        error={nameError}
      />
      <SelectField
        label="Kind"
        name="kind"
        defaultValue="ACADEMIC"
        hint="It can’t change once the type is made."
      >
        <option value="ACADEMIC">Academic</option>
        <option value="ADMINISTRATIVE">Administrative</option>
        <option value="RESEARCH">Research</option>
      </SelectField>
      <div className="org-form__actions">
        <Button type="submit" pending={pending}>
          Add the type
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
