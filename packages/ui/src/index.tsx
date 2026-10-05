// UniVarse base components, server-safe (no hooks). Interactive ones live in `@univarse/ui/client`.
// Styles: tokens.css + components.css. World: apps/web/.impeccable/surfaces/src-app.md.
import type { ComponentProps, ReactNode } from 'react';
import { AlertCircle, Check, InfoCircle } from './icons';

export * from './icons';

type Variant = 'action' | 'quiet' | 'plain';

/** The one action colour (lime) marks the one thing to press; `quiet` and `plain` for the rest. */
export function Button({
  variant = 'action',
  block = false,
  pending = false,
  className,
  children,
  disabled,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; block?: boolean; pending?: boolean }) {
  const classes = ['uv-btn', `uv-btn--${variant}`, block ? 'uv-btn--block' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={classes} disabled={disabled === true || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? <span className="uv-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** Class names for links styled as buttons (Next's Link lives in the app, not here). */
export const buttonClass = (variant: Variant = 'action', block = false) =>
  ['uv-btn', `uv-btn--${variant}`, block ? 'uv-btn--block' : ''].filter(Boolean).join(' ');

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  return (
    <div className={['uv-card', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

const TONE_ICON = { danger: AlertCircle, info: InfoCircle, success: Check } as const;

/**
 * Status message. Errors always carry the request id for support (docs/11 §2). Tinted panel with an
 * icon; never a coloured side stripe (craft floor).
 */
export function Notice({
  tone = 'danger',
  requestId,
  children,
}: {
  tone?: 'danger' | 'info' | 'success';
  requestId?: string | undefined;
  children: ReactNode;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`uv-notice uv-notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} />
      <div>
        {children}
        {requestId ? <span className="uv-notice__ref">Support reference: {requestId}</span> : null}
      </div>
    </div>
  );
}

/** One fixed frame per flow; the strip shows where you are (spec 0005 W11–W13). */
export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="uv-steps" aria-label={`Step ${current + 1} of ${steps.length}`}>
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={label} className="uv-steps__item" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="uv-steps__bar" />
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
