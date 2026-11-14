import type { ResponseBody } from '@univarse/api-client';
import { Clock, Megaphone } from '@univarse/ui';
import { DismissNotice } from './DismissNotice';

export type NoticeBanner = ResponseBody<'/api/v1/notices', 'get'>['data'][number];

const KIND: Record<NoticeBanner['kind'], string> = {
  MAINTENANCE: 'Planned maintenance',
  ANNOUNCEMENT: 'From UniVarse',
  RELEASE_NOTE: 'What’s new',
};

const day = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const time = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });

/** "Wed 18 Nov, 10:00 pm to 1:00 am (Thu 19 Nov)": the window in Nigerian time, the end's day only when it differs. */
export function windowText(startsAt: string, endsAt: string): string {
  const [s, e] = [new Date(startsAt), new Date(endsAt)];
  const sameDay = day.format(s) === day.format(e);
  return `${day.format(s)}, ${time.format(s)} to ${time.format(e)}${sameDay ? '' : ` (${day.format(e)})`}, Nigerian time`;
}

/**
 * Spec 0037 Q10 (T34): notices from UniVarse at this institution. Plain text only: the title and body are React text
 * nodes, never markup, so anything in them (a tag, a script, a link) shows as the characters it is. Maintenance is
 * for everyone; announcements and release notes reach IT Admins (the API decides). Signed in, each can be dismissed.
 */
export function NoticeBanners({ notices, dismissible }: { notices: readonly NoticeBanner[]; dismissible: boolean }) {
  if (notices.length === 0) return null;
  return (
    <section className="notices" aria-label="Notices from UniVarse">
      <ul className="notices__list">
        {notices.map((n) => (
          <li key={n.id} className={`notice notice--${n.kind.toLowerCase()}`}>
            <span className="notice__icon" aria-hidden="true">
              {n.kind === 'MAINTENANCE' ? <Clock size={18} /> : <Megaphone size={18} />}
            </span>
            <div className="notice__text">
              <p className="notice__kind">{KIND[n.kind]}</p>
              <p className="notice__title">{n.title}</p>
              {n.kind === 'MAINTENANCE' && n.startsAt && n.endsAt ? <p className="notice__window">{windowText(n.startsAt, n.endsAt)}</p> : null}
              <p className="notice__body">{n.body}</p>
            </div>
            {dismissible ? <DismissNotice id={n.id} title={n.title} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
