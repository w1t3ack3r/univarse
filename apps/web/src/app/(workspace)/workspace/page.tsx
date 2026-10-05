import { ArrowRight, Card, Grid, ShieldCheck, Users, buttonClass } from '@univarse/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildNav, NAV } from '@/lib/nav';
import { serverApi } from '@/lib/server-api';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Home' };

/** Greeting by the time of day in Lagos (docs/11 §8), not the server's clock zone. */
function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-NG', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Lagos' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

const DESTINATION: Record<string, { icon: typeof Users; meta: string }> = {
  '/workspace/users': { icon: Users, meta: 'People in your institution and their account status' },
  '/workspace/products': { icon: Grid, meta: 'Switch on the parts of UniVarse your institution uses' },
};

export default async function WorkspaceHome() {
  const me = await requireSession();
  const products = await serverApi<{ data: string[] }>('/api/v1/products');
  const destinations = buildNav(NAV, me.permissions, products.body?.data ?? ['core']).filter((i) => i.href !== '/workspace');
  const firstName = me.displayName.split(/\s+/)[0] ?? me.displayName;

  return (
    <div className="page">
      <h1 className="page__title">
        {greeting()}, <span className="uv-highlight">{firstName}</span>
      </h1>
      <p className="page__lede">Here’s what you can do today. More appears as your institution switches on new parts of UniVarse.</p>

      <Card>
        <div className="list__row list__row--flat">
          <span className="uv-icon-tile">
            <ShieldCheck />
          </span>
          <span className="list__text">
            <span className="list__title">Two-step sign-in</span>
            <span className="list__meta">
              {me.mfa ? 'On. Signing in needs a code from your phone.' : 'Off. Add a code from your phone so a stolen password isn’t enough.'}
            </span>
          </span>
          {me.mfa ? (
            <span className="status status--on">On</span>
          ) : (
            <Link className={buttonClass('action')} href="/mfa/setup">
              Turn it on
            </Link>
          )}
        </div>
      </Card>

      {destinations.length > 0 ? (
        <Card>
          <h2 className="section-title">Your workspace</h2>
          <ul className="list">
            {destinations.map((d) => {
              const extra = DESTINATION[d.href];
              const Icon = extra?.icon ?? Grid;
              return (
                <li key={d.href}>
                  <Link className="list__row" href={d.href}>
                    <span className="uv-icon-tile">
                      <Icon />
                    </span>
                    <span className="list__text">
                      <span className="list__title">{d.label}</span>
                      {extra ? <span className="list__meta">{extra.meta}</span> : null}
                    </span>
                    <ArrowRight />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
