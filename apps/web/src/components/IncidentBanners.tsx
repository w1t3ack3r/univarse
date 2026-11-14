import { AlertCircle, Check } from '@univarse/ui';
import type { IncidentList } from '@/lib/tenant';

const STATUS: Record<IncidentList[number]['status'], string> = {
  INVESTIGATING: 'Investigating',
  IDENTIFIED: 'Cause found, fixing',
  MONITORING: 'Fixed, watching',
  RESOLVED: 'Resolved',
};

const at = new Intl.DateTimeFormat('en-NG', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });

/**
 * Spec 0037 Q14 (T34): what UniVarse says about an incident affecting this institution, open or resolved in the last
 * day, with its latest update. Text nodes only. Everyone sees it, signed in or not, and it isn't dismissible: it leaves
 * a day after it's resolved.
 */
export function IncidentBanners({ incidents }: { incidents: IncidentList }) {
  if (incidents.length === 0) return null;
  return (
    <section className="incidents" aria-label="Service status">
      <ul className="incidents__list">
        {incidents.map((i) => {
          const resolved = i.status === 'RESOLVED';
          return (
            <li key={i.id} className={`incident${resolved ? ' incident--resolved' : ''}`}>
              <span className="incident__icon" aria-hidden="true">
                {resolved ? <Check size={18} /> : <AlertCircle size={18} />}
              </span>
              <div className="incident__text">
                <p className="incident__status">
                  {STATUS[i.status]} · updated {at.format(new Date(i.latest.at))}
                </p>
                <p className="incident__title">{i.title}</p>
                <p className="incident__body">{i.latest.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
