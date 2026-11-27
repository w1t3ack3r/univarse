import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { StructureView } from './StructureView';
import './structure.css';

export const metadata: Metadata = { title: 'Structure' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Spec 0042 (P2-S1): the institution's org tree, drawn as its organisation chart. The tree comes whole, once
 * (Q14), in the caller's scope; "as at" and "show archived" are in the address, so a view can be shared and the
 * back button works. Choosing, searching and editing happen in the page.
 */
export default async function StructurePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireSession();
  const sp = await searchParams;
  const asAt = typeof sp.asAt === 'string' && DAY.test(sp.asAt) ? sp.asAt : undefined;
  const archived = sp.archived === '1';
  const [units, types] = await Promise.all([
    serverGet((api) =>
      api.GET('/api/v1/org/units', {
        params: {
          query: { ...(asAt ? { asAt } : {}), ...(archived ? { includeArchived: 'true' } : {}) },
        },
      }),
    ),
    serverGet((api) => api.GET('/api/v1/org/unit-types')),
  ]);
  if (units.status === 403 || types.status === 403) notFound();
  return (
    <div className="page page--wide">
      <h1 className="page__title">Structure</h1>
      <p className="page__lede">
        Your institution’s faculties, schools, departments and offices, and how they fit together.
      </p>
      <StructureView
        units={units.status === 200 && units.data ? units.data.data : []}
        unitsFailed={
          units.status !== 200 ? { status: units.status, requestId: units.requestId } : null
        }
        types={types.status === 200 && types.data ? types.data.data : []}
        canManageTypes={types.status === 200 && types.data ? types.data.canManage : false}
        canManage={me.permissions.includes('org.unit.manage')}
        asAt={units.status === 200 && units.data ? units.data.asAt : null}
        showArchived={archived}
      />
    </div>
  );
}
