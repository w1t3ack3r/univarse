import { ArrowLeft, buttonClass } from '@univarse/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { UnitTypes } from './UnitTypes';
import '../structure.css';

export const metadata: Metadata = { title: 'Unit types' };

/**
 * Spec 0042 Q1, Q2: the institution's own kinds of unit, from its profile and then its own: their names, what each
 * may hold, and which are archived. A changed rule never moves a unit (the chart flags any that no longer fit).
 */
export default async function UnitTypesPage() {
  await requireSession();
  const res = await serverGet((api) => api.GET('/api/v1/org/unit-types'));
  if (res.status !== 200 || !res.data) notFound();
  return (
    <div className="page">
      <Link href="/workspace/structure" className={`${buttonClass('plain')} types__back`}>
        <ArrowLeft size={20} />
        Structure
      </Link>
      <h1 className="page__title">Unit types</h1>
      <p className="page__lede">
        The kinds of unit your institution has, in its own words, and what each may hold. A change
        here applies to units added or moved from now on; nothing already in place moves.
      </p>
      <UnitTypes initial={res.data.data} canManage={res.data.canManage} />
    </div>
  );
}
