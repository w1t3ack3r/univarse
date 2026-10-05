// UniVarse base components (docs/11 §3). Styles: tokens.css + components.css.
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type Variant = 'accent' | 'primary' | 'ghost';

export function Button({
  variant = 'accent',
  block = false,
  pending = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean; pending?: boolean }) {
  const classes = ['uv-btn', `uv-btn--${variant}`, block ? 'uv-btn--block' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={classes} disabled={disabled === true || pending} aria-busy={pending || undefined} {...rest}>
      {children}
    </button>
  );
}

/**
 * A labelled input. Hint and error are linked with aria-describedby, and an error sets aria-invalid
 * (spec 0005 W9).
 */
export function TextField({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | undefined }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="uv-field">
      <label className="uv-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <span className="uv-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <input
        id={id}
        className="uv-field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {error ? (
        <span className="uv-field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Problem or status message. Errors always show the request id for support (docs/11 §2). */
export function Alert({
  tone = 'danger',
  requestId,
  children,
}: {
  tone?: 'danger' | 'info' | 'success';
  requestId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`uv-alert uv-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
      {requestId ? <span className="uv-alert__ref">Reference: {requestId}</span> : null}
    </div>
  );
}
