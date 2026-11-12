import { AlertCircle, Check } from '@univarse/ui';
import { STEP } from './labels';

export interface TrackStep {
  readonly step: string;
  readonly status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  readonly attempts?: number;
}

const SAID: Readonly<Record<TrackStep['status'], string>> = { PENDING: 'Not started', RUNNING: 'Running', DONE: 'Done', FAILED: 'Stopped here' };

/**
 * Spec 0034 Q13: provisioning's eight steps as one track. The same list previews what will happen on the "New
 * institution" form and shows what is happening once it runs: each step's state in words and a mark, never colour
 * alone. A running step's mark turns; under reduced motion it holds still and the word says it.
 */
export function StepTrack({ steps, label }: { steps: readonly TrackStep[]; label: string }) {
  return (
    <ol className="pc-track" aria-label={label}>
      {steps.map((s) => {
        const about = STEP[s.step] ?? { label: s.step, about: '' };
        return (
          <li key={s.step} className="pc-track__step" data-state={s.status.toLowerCase()} aria-current={s.status === 'RUNNING' ? 'step' : undefined}>
            <span className="pc-track__mark" aria-hidden="true">
              {s.status === 'DONE' ? <Check size={14} /> : s.status === 'FAILED' ? <AlertCircle size={14} /> : null}
            </span>
            <span className="pc-track__text">
              <span className="pc-track__label">
                {about.label}
                <span className="uv-visually-hidden">: {SAID[s.status]}</span>
              </span>
              <span className="pc-track__about">{about.about}</span>
            </span>
            {s.status === 'RUNNING' || s.status === 'FAILED' || (s.attempts ?? 0) > 1 ? (
              <span className="pc-track__state" aria-hidden="true">
                {SAID[s.status]}
                {(s.attempts ?? 0) > 1 ? `, try ${String(s.attempts)}` : ''}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
