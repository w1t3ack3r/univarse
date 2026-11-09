'use client';

import { checkLogo, MIN_CONTRAST, contrastRatio, textColorOn, type LogoProblem } from '@univarse/domain';
import { Button, Notice } from '@univarse/ui';
import { useState, type ChangeEvent } from 'react';
import { useStepUp } from '../../../components/step-up';
import { api } from '../../../lib/api';
import type { Changing, Tenant } from './institution-view';

const HEX = /^#[0-9A-F]{6}$/;
const FALLBACK = '#485550';
const WHY: Readonly<Record<LogoProblem, string>> = {
  too_large: 'That file is over 256 KB.',
  not_png_or_webp: 'That isn’t a PNG or WebP image. SVG isn’t accepted, because it can carry script.',
  too_many_pixels: 'That image is larger than 1024 × 1024.',
};

function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Spec 0033 Q9, Q10: a colour and a logo, with a preview of how they'll sit together. The same checks as the server's,
 * run here first, so a colour nobody can read is explained before anyone asks for an authenticator code.
 */
export function BrandingSection({ tenant, canEdit, changing }: { tenant: Tenant; canEdit: boolean; changing: Changing }) {
  const stepUp = useStepUp();
  const saved = tenant.branding.primaryColor;
  const [hex, setHex] = useState(saved ?? '');
  const [busy, setBusy] = useState<'color' | 'logo' | 'remove' | null>(null);
  const [picked, setPicked] = useState<{ base64: string; url: string } | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  const valid = HEX.test(hex);
  const text = valid ? textColorOn(hex) : null;
  const unreadable = valid && text === null;
  const shown = valid && text ? hex : (saved ?? FALLBACK);
  const shownText = valid && text ? text : (tenant.branding.textColor ?? '#FFFFFF');
  const logoUrl = picked?.url ?? (tenant.branding.logoSha256 ? `/api/platform/v1/tenants/${tenant.id}/branding/logo?v=${tenant.branding.logoSha256}` : null);

  const put = (what: 'color' | 'logo' | 'remove', action: () => Promise<unknown>, message: string) => {
    setBusy(what);
    stepUp(async () => {
      await action();
      return true;
    })
      .then((ok) => {
        if (ok) changing.changed(message);
      })
      .catch(changing.failed)
      .finally(() => setBusy(null));
  };

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setLogoError(null);
    setPicked(null);
    if (!file) return;
    void file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      const check = checkLogo(bytes);
      if (!check.ok) {
        setLogoError(WHY[check.problem]);
        return;
      }
      setPicked({ base64: base64Of(bytes), url: URL.createObjectURL(file) });
    });
  };

  return (
    <section className="pc-section" aria-labelledby="t-branding">
      <h2 id="t-branding" className="pc-section__title">
        Branding
      </h2>
      <p className="pc-section__lead">Shown on this institution’s sign-in page and workspace.</p>

      <div className="pc-brand" style={{ background: shown, color: shownText }} role="img" aria-label={`Preview: ${tenant.shortName} on ${shown}`}>
        {logoUrl ? <img className="pc-brand__logo" src={logoUrl} alt="" /> : null}
        <span className="pc-brand__name">{tenant.shortName}</span>
        <span className="pc-brand__button" style={{ background: shownText, color: shown }}>
          Sign in
        </span>
      </div>

      {canEdit ? (
        <div className="pc-brand__forms">
          <div className="pc-form">
            <div className="uv-field">
              <label className="uv-field__label" htmlFor="b-hex">
                Primary colour
              </label>
              <div className="pc-color">
                <input className="pc-color__swatch" type="color" aria-label="Pick a colour" value={valid ? hex.toLowerCase() : FALLBACK} onChange={(e) => setHex(e.target.value.toUpperCase())} />
                <input id="b-hex" className="uv-field__input" value={hex} placeholder="#1A3A6B" spellCheck={false} autoComplete="off" maxLength={7} aria-invalid={unreadable || undefined} aria-describedby="b-hex-note" onChange={(e) => setHex(e.target.value.trim().toUpperCase())} />
              </div>
              <p id="b-hex-note" className="pc-note">
                {unreadable ? `Neither white nor the brand ink reaches ${String(MIN_CONTRAST)}:1 on this colour, so text wouldn’t be readable. Choose a darker or lighter one.` : valid && text ? `Text on it will be ${text === '#FFFFFF' ? 'white' : 'the brand ink'}, at ${contrastRatio(hex, text).toFixed(1)}:1.` : 'As #RRGGBB. Leave it empty for the UniVarse colours.'}
              </p>
            </div>
            <div className="pc-row-actions pc-row-actions--start">
              <Button type="button" variant="quiet" pending={busy === 'color'} disabled={hex !== '' && (!valid || text === null)} onClick={() => put('color', () => api('PUT', `/tenants/${tenant.id}/branding/color`, { primaryColor: hex === '' ? null : hex }), 'The colour is saved.')}>
                Save the colour
              </Button>
            </div>
          </div>

          <div className="pc-form">
            <div className="uv-field">
              <label className="uv-field__label" htmlFor="b-logo">
                Logo
              </label>
              <input id="b-logo" className="pc-file" type="file" accept="image/png,image/webp" aria-describedby="b-logo-note" onChange={choose} />
              <p id="b-logo-note" className="pc-note">
                PNG or WebP, at most 256 KB and 1024 × 1024.
              </p>
            </div>
            {logoError ? <Notice>{logoError}</Notice> : null}
            <div className="pc-row-actions pc-row-actions--start">
              <Button type="button" variant="quiet" pending={busy === 'logo'} disabled={!picked} onClick={() => picked && put('logo', () => api('PUT', `/tenants/${tenant.id}/branding/logo`, { base64: picked.base64 }), 'The logo is saved.')}>
                Save the logo
              </Button>
              {tenant.branding.logoSha256 ? (
                <Button type="button" variant="plain" pending={busy === 'remove'} onClick={() => put('remove', () => api('DELETE', `/tenants/${tenant.id}/branding/logo`), 'The logo is removed.')}>
                  Remove the logo
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
