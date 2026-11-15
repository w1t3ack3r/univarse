import { Clock } from '@univarse/ui';

const day = new Intl.DateTimeFormat('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });

/**
 * Spec 0038 Q3: an institution that is leaving UniVarse says so, to everyone there, with the day its account closes.
 * The date is the platform's, read from this host's own institution.
 */
export function ClosingBanner({ legalName, closesAt }: { legalName: string; closesAt: string | null }) {
  if (!closesAt) return null;
  return (
    <section className="closing" aria-label="Account closing">
      <span className="closing__icon" aria-hidden="true">
        <Clock size={18} />
      </span>
      <div className="closing__text">
        <p className="closing__title">
          UniVarse closes for {legalName} at the end of {day.format(new Date(closesAt))}.
        </p>
        <p className="closing__body">Until then, everything works as usual. After it, nobody can sign in. Your institution’s ICT unit can take a copy of its data before then.</p>
      </div>
    </section>
  );
}
