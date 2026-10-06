import type { SettingViewOf } from '@univarse/api-client';
import { Card, Sliders } from '@univarse/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { UnitLimitsCard } from './UnitLimitsCard';

export const metadata: Metadata = { title: 'Settings' };

/**
 * Spec 0007 ST13. Everyone with settings.tenant.view reads; only holders of a key's own manage
 * permission (the Registrar for registration keys) get a form. The API enforces all of it.
 */
export default async function SettingsPage() {
  await requireSession();
  const res = await serverGet((api) => api.GET('/api/v1/settings'));
  if (res.status !== 200 || !res.data) notFound();
   
  const unitLimits = res.data.data.find((s): s is SettingViewOf<'registration.unitLimits'> => s.key === 'registration.unitLimits');

  return (
    <div className="page">
      <h1 className="page__title">Settings</h1>
      <p className="page__lede">Rules your institution sets for itself. Every change takes effect straight away and is recorded with who made it.</p>

      <section className="settings-section" aria-labelledby="s-registration">
        <h2 className="section-title" id="s-registration">
          Course registration
        </h2>
        {unitLimits ? (
          <UnitLimitsCard initial={unitLimits} />
        ) : (
          <Card>
            <div className="setting__empty">
              <span className="uv-icon-tile">
                <Sliders />
              </span>
              <p>Course registration settings appear here once Academics is switched on for your institution.</p>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
