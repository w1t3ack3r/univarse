'use client';

import {
  AlertCircle,
  Archive,
  Button,
  buttonClass,
  ChevronDown,
  Notice,
  Pause,
  Plus,
  Search,
} from '@univarse/ui';
import { TextField } from '@univarse/ui/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import { ancestorsOf, buildTree, moveTargets, searchHits, type Tree } from './tree';
import { UnitPanel, type Mode } from './UnitPanel';
import { longDay, plural, STATE_WORD, today, type Unit, type UnitType } from './words';

interface Props {
  units: Unit[];
  unitsFailed: { status: number; requestId: string | undefined } | null;
  types: UnitType[];
  canManageTypes: boolean;
  /** `org.unit.manage` at the institution: adding under the institution itself. Per-unit rights come with each unit. */
  canManage: boolean;
  asAt: string | null;
  showArchived: boolean;
}

/**
 * Spec 0042 (PR B): the organisation chart. The institution is the trunk; its units hang below as branches. Choosing
 * a unit opens it in the panel, where every change is made; dragging a unit onto another only opens the move there
 * (Q11: a move is never made on a drop).
 */
export function StructureView({
  units,
  unitsFailed,
  types,
  canManageTypes,
  canManage,
  asAt,
  showArchived,
}: Props) {
  const router = useRouter();
  const tree = useMemo(() => buildTree(units), [units]);
  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  /** Folds the person changed; anything else is open to the branches' children (depth ≤ 1), folded below. */
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<{ id: string; targets: Set<string> } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const hits = useMemo(() => searchHits(tree, query), [tree, query]);
  const readOnly = asAt !== null;
  const root = tree.tops.length === 1 && tree.tops[0]?.parentId === null ? tree.tops[0] : null;
  const editing = mode.kind !== 'view';

  const go = (next: { asAt?: string | null; archived?: boolean }) => {
    const p = new URLSearchParams();
    const day = next.asAt === undefined ? asAt : next.asAt;
    const arch = next.archived ?? showArchived;
    if (day) p.set('asAt', day);
    if (arch) p.set('archived', '1');
    const qs = p.toString();
    setMode({ kind: 'view' });
    setSelected(null); // another day or filter: the chosen unit may not be in it
    router.push(`/workspace/structure${qs ? `?${qs}` : ''}`);
  };

  const choose = (id: string, m: Mode = { kind: 'view' }) => {
    setFlash(null);
    setSelected(id);
    setMode(m);
    // The path to the chosen unit opens, so it's on the chart.
    setFolds((was) => {
      const next = new Map(was);
      for (const a of ancestorsOf(tree, id)) next.set(a.id, true);
      return next;
    });
  };

  const isOpenAt = (id: string, depth: number) => folds.get(id) ?? depth <= 1;
  const toggle = (id: string, depth: number) =>
    setFolds((was) => new Map(was).set(id, !isOpenAt(id, depth)));

  const drag = {
    start: (u: Unit) => (e: DragEvent) => {
      const targets = new Set(moveTargets(tree, u, types).map((t) => t.id));
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', u.id);
      setDragging({ id: u.id, targets });
    },
    over: (u: Unit) => (e: DragEvent) => {
      if (!dragging?.targets.has(u.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(u.id);
    },
    drop: (u: Unit) => (e: DragEvent) => {
      if (!dragging?.targets.has(u.id)) return;
      e.preventDefault();
      choose(dragging.id, { kind: 'move', to: u.id });
      setDragging(null);
      setOver(null);
    },
    end: () => {
      setDragging(null);
      setOver(null);
    },
  };

  if (unitsFailed) {
    return (
      <Notice requestId={unitsFailed.requestId}>
        We couldn’t load the structure just now. Reload the page to try again.
      </Notice>
    );
  }

  const matchCount = hits?.matches.size ?? 0;
  const node = (u: Unit, depth: number): ReactNode => {
    if (hits && !hits.shown.has(u.id)) return null;
    const kids = tree.children.get(u.id) ?? [];
    const isOpen = hits ? true : isOpenAt(u.id, depth);
    const stemId = `stem-${u.id}`;
    const canDrag = !readOnly && u.parentId !== null && u.state !== 'ARCHIVED';
    const target = dragging?.targets.has(u.id) ?? false;
    const cls = [
      'org-node',
      u.id === selected ? 'org-node--selected' : '',
      u.state !== 'ACTIVE' ? `org-node--${u.state.toLowerCase()}` : '',
      dragging
        ? target
          ? 'org-node--target'
          : dragging.id === u.id
            ? 'org-node--dragged'
            : 'org-node--dim'
        : '',
      over === u.id ? 'org-node--over' : '',
      hits?.matches.has(u.id) ? 'org-node--match' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <li key={u.id} className={depth === 1 ? 'org__branch' : 'org__leaf'}>
        <div
          className={cls}
          draggable={canDrag}
          onDragStart={canDrag ? drag.start(u) : undefined}
          onDragEnd={drag.end}
          onDragOver={drag.over(u)}
          onDragLeave={() => setOver((o) => (o === u.id ? null : o))}
          onDrop={drag.drop(u)}
        >
          <button
            type="button"
            className="org-node__main"
            aria-pressed={u.id === selected}
            onClick={() => choose(u.id)}
          >
            <span className="org-node__name">{marked(u.name, query)}</span>
            <span className="org-node__meta">
              {u.typeId ? (typeName.get(u.typeId) ?? 'Unit') : 'The institution'}
              {u.code ? (
                <>
                  {' · '}
                  <span className="org-node__code">{marked(u.code, query)}</span>
                </>
              ) : null}
            </span>
            {u.state !== 'ACTIVE' || !u.followsRules ? (
              <span className="org-node__flags">
                {u.state !== 'ACTIVE' ? (
                  <span
                    className={`status ${u.state === 'ARCHIVED' ? 'status--archived' : 'status--off'}`}
                  >
                    {u.state === 'ARCHIVED' ? <Archive size={14} /> : <Pause size={14} />}
                    {STATE_WORD[u.state]}
                  </span>
                ) : null}
                {!u.followsRules ? (
                  <span className="status status--warn">
                    <AlertCircle size={14} />
                    Doesn’t fit the current rules
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          {kids.length > 0 && !hits ? (
            <button
              type="button"
              className="org-node__fold"
              aria-expanded={isOpen}
              aria-controls={stemId}
              onClick={() => toggle(u.id, depth)}
            >
              <ChevronDown size={18} />
              <span>{plural(kids.length, 'unit')}</span>
              <span className="uv-visually-hidden">
                {isOpen ? `, shown, in ${u.name}` : `, hidden, in ${u.name}`}
              </span>
            </button>
          ) : null}
        </div>
        {kids.length > 0 && isOpen ? (
          <ul className="org__stem" id={stemId}>
            {kids.map((k) => node(k, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className={`org${selected ? ' org--open' : ''}`}>
      <div className="org__toolbar" role="search" aria-label="Find and filter units">
        <div className="org__find">
          <Search size={20} className="org__find-icon" />
          <TextField
            label="Find a unit"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or code"
            autoComplete="off"
          />
        </div>
        <TextField
          label="As at"
          type="date"
          className="org__day"
          value={asAt ?? today()}
          max={today()}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= today())
              go({ asAt: v === today() ? null : v });
          }}
        />
        <button
          type="button"
          role="switch"
          aria-checked={showArchived}
          className="switch org__archived"
          onClick={() => go({ archived: !showArchived })}
        >
          <span className="switch__track">
            <span className="switch__thumb" />
          </span>
          <span className="switch__text">Show archived</span>
        </button>
        <div className="org__tools-end">
          <Link href="/workspace/structure/types" className={buttonClass('plain')}>
            {canManageTypes ? 'Edit unit types' : 'Unit types'}
          </Link>
          {canManage && root && !readOnly ? (
            <Button
              variant={editing ? 'quiet' : 'action'}
              onClick={() => choose(root.id, { kind: 'add' })}
            >
              <Plus size={20} />
              Add a unit
            </Button>
          ) : null}
        </div>
      </div>

      {readOnly && asAt ? (
        <Notice tone="info">
          The structure as it was at the end of {longDay(asAt)}. Nothing can be changed here.{' '}
          <button
            type="button"
            className={`${buttonClass('plain')} org__inline-link`}
            onClick={() => go({ asAt: null })}
          >
            Back to today
          </button>
        </Notice>
      ) : null}
      <p className="uv-visually-hidden" aria-live="polite">
        {hits
          ? matchCount === 0
            ? 'No units match.'
            : `${plural(matchCount, 'unit')} match.`
          : ''}
      </p>
      {hits && matchCount === 0 ? (
        <p className="org__empty">No unit’s name or code holds “{query.trim()}”.</p>
      ) : null}
      {dragging ? (
        <p className="org__hint" aria-live="polite">
          {dragging.targets.size > 0
            ? 'Drop it on the unit it should sit under. Nothing moves until you confirm.'
            : 'There’s nowhere this unit can move to.'}
        </p>
      ) : null}

      <div className={`org__layout${selected ? ' org__layout--open' : ''}`}>
        <section className="org__chart" aria-label="Organisation chart">
          {tree.tops.length === 0 ? (
            <p className="org__empty">There’s no structure to show for this day.</p>
          ) : null}
          {tree.tops.map((top) => (
            <Trunk
              key={top.id}
              tree={tree}
              top={top}
              selected={selected}
              onChoose={choose}
              hidden={hits !== null && !hits.shown.has(top.id)}
              query={query}
              typeName={typeName}
              drop={{
                target: dragging?.targets.has(top.id) ?? false,
                over: over === top.id,
                dim: dragging !== null && !(dragging.targets.has(top.id) || dragging.id === top.id),
                onDragOver: drag.over(top),
                onDragLeave: () => setOver((o) => (o === top.id ? null : o)),
                onDrop: drag.drop(top),
              }}
            >
              {(tree.children.get(top.id) ?? []).map((k) => node(k, 1))}
            </Trunk>
          ))}
        </section>
        {selected ? (
          <aside className="org__panel" aria-label="The chosen unit">
            <UnitPanel
              key={selected}
              id={selected}
              tree={tree}
              types={types}
              mode={mode}
              setMode={setMode}
              readOnly={readOnly}
              onChoose={choose}
              onClose={() => {
                setSelected(null);
                setMode({ kind: 'view' });
              }}
              flash={flash}
              onChanged={(created, message) => {
                router.refresh();
                if (created) {
                  choose(created);
                  setFlash(message ?? null);
                }
              }}
            />
          </aside>
        ) : (
          <aside className="org__panel org__panel--idle" aria-label="The chosen unit">
            <p>Choose a unit to see what it is, what’s inside it and what has happened to it.</p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** The institution (or, for a scoped caller, the top of their part): the trunk card, its branches below. */
function Trunk({
  tree,
  top,
  selected,
  onChoose,
  hidden,
  query,
  typeName,
  drop,
  children,
}: {
  tree: Tree;
  top: Unit;
  selected: string | null;
  onChoose: (id: string) => void;
  hidden: boolean;
  query: string;
  typeName: Map<string, string>;
  /** The trunk is a place to drop a unit too: the institution may hold every type (Q3). */
  drop: {
    target: boolean;
    over: boolean;
    dim: boolean;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
  children: ReactNode;
}) {
  const branches = tree.children.get(top.id) ?? [];
  const all = countBelow(tree, top.id);
  // The spine runs from the trunk to the last row's rail: measured, since the grid decides where rows break.
  const list = useRef<HTMLUListElement>(null);
  const [spine, setSpine] = useState(16);
  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const measure = () => {
      const tops = [...ul.children].map((c) => (c as HTMLElement).offsetTop);
      setSpine(Math.max(16, Math.max(0, ...tops) - 16));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [branches.length, hidden]);
  // After every hook: the number of hooks never changes between renders.
  if (hidden) return null;
  return (
    <div className="org__trunk-group">
      <button
        type="button"
        className={[
          'org-trunk',
          top.id === selected ? 'org-trunk--selected' : '',
          drop.target ? 'org-trunk--target' : '',
          drop.over ? 'org-trunk--over' : '',
          drop.dim ? 'org-node--dim' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-pressed={top.id === selected}
        onClick={() => onChoose(top.id)}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <span className="org-trunk__name">{marked(top.name, query)}</span>
        <span className="org-trunk__meta">
          {top.typeId
            ? `${typeName.get(top.typeId) ?? 'Unit'}${top.code ? ` · ${top.code}` : ''}`
            : 'The institution'}
          {' · '}
          {branches.length === all
            ? plural(all, 'unit')
            : `${plural(branches.length, 'unit')} directly, ${String(all)} in all`}
        </span>
      </button>
      {branches.length > 0 ? (
        <ul
          className="org__branches"
          ref={list}
          style={{ '--org-spine': `${String(spine)}px` } as CSSProperties}
        >
          {children}
        </ul>
      ) : null}
    </div>
  );
}

function countBelow(tree: Tree, id: string): number {
  return (tree.children.get(id) ?? []).reduce((n, c) => n + 1 + countBelow(tree, c.id), 0);
}

/** The text with the search's match marked (case and accents aside). */
function marked(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Marked only when folding kept the length, so the match's indexes are the text's own.
  const folded = fold(text);
  const at = folded.indexOf(fold(q));
  if (at < 0 || folded.length !== text.length) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="org__mark">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
