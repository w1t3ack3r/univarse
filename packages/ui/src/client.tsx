'use client';
// Interactive UniVarse components. Import from `@univarse/ui/client` in client components only.
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Check, Clock, Copy, Eye, EyeOff } from './icons';

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
};

function useDescribedBy(hint: ReactNode, error: string | undefined) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return { id, hintId, errorId, describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined };
}

function FieldMessages({ hint, hintId, error, errorId }: { hint: ReactNode; hintId?: string | undefined; error?: string | undefined; errorId?: string | undefined }) {
  return (
    <>
      {hint ? (
        <span className="uv-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="uv-field__error" id={errorId}>
          <AlertCircle size={16} />
          {error}
        </span>
      ) : null}
    </>
  );
}

/** Labelled input; hint and error linked with aria-describedby, error sets aria-invalid (W9). */
export function TextField({ label, hint, error, className, ...input }: FieldProps) {
  const { id, hintId, errorId, describedBy } = useDescribedBy(hint, error);
  return (
    <div className="uv-field">
      <label className="uv-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={['uv-field__input', className ?? ''].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

/** Password with a show/hide toggle (fewer typos on phones, no copy-paste trap). */
export function PasswordField({ label, hint, error, ...input }: Omit<FieldProps, 'type'>) {
  const { id, hintId, errorId, describedBy } = useDescribedBy(hint, error);
  const [shown, setShown] = useState(false);
  return (
    <div className="uv-field">
      <label className="uv-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="uv-field__control">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          className="uv-field__input uv-field__input--with-toggle"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoCapitalize="none"
          spellCheck={false}
          {...input}
        />
        <button
          type="button"
          className="uv-field__toggle"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      </div>
      <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

/**
 * The signature interaction: one real input (paste, SMS/email autofill, screen readers) drawn as
 * fixed one-digit cells. Non-digits are dropped as you type or paste.
 */
export function CodeField({
  label,
  hint,
  error,
  value,
  onChange,
  length = 6,
  autoFocus,
  name = 'code',
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  length?: number;
  autoFocus?: boolean;
  name?: string;
}) {
  const { id, hintId, errorId, describedBy } = useDescribedBy(hint, error);
  const [focused, setFocused] = useState(false);
  const digits = value.split('');
  const active = Math.min(value.length, length - 1);
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
      <div className="uv-code" data-invalid={error ? 'true' : undefined} style={{ ['--uv-code-len' as string]: length }}>
        <div className="uv-code__cells" aria-hidden="true">
          {Array.from({ length }, (_, i) => (
            <span
              key={i}
              className="uv-code__cell"
              data-filled={digits[i] ? 'true' : undefined}
              data-active={focused && i === active && value.length < length + 1 ? 'true' : undefined}
            >
              {digits[i] ?? ''}
            </span>
          ))}
        </div>
        <input
          id={id}
          name={name}
          className="uv-code__input"
          value={value}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={`[0-9]{${length}}`}
          maxLength={length}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        />
      </div>
      {error ? (
        <span className="uv-field__error" id={errorId}>
          <AlertCircle size={16} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** "Valid for N minutes": a bar whose length is the exact time left, plus words for everyone. */
export function ExpiryBar({ issuedAt, minutes, onExpire }: { issuedAt: number; minutes: number; onExpire?: () => void }) {
  const total = minutes * 60_000;
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, issuedAt + total - now);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [left, onExpire]);
  const mins = Math.ceil(left / 60_000);
  const from = Math.max(0, Math.min(1, left / total));
  return (
    <div className="uv-expiry">
      <div className="uv-expiry__track" aria-hidden="true">
        <div
          key={issuedAt}
          className="uv-expiry__fill"
          style={{ ['--uv-expiry-from' as string]: from, animationDuration: `${left}ms`, transform: `scaleX(${from})` }}
        />
      </div>
      <span className="uv-expiry__label">
        <Clock size={14} />
        {left === 0 ? 'This code has expired. Ask for a new one.' : `Valid for ${mins === 1 ? 'about a minute' : `${mins} more minutes`}`}
      </span>
    </div>
  );
}

/** Copies text and says so (status announced politely). */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="uv-btn uv-btn--quiet"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2400);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}
