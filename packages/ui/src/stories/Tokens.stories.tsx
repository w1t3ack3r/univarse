import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

// Spec 0026 SB2: each text/ground pair the components use, with its contrast measured from the live tokens.css, so the
// page can't drift from the CSS. The brand rule shows as a pair that is never text: lime on a light ground.
const PAIRS = [
  { fg: '--uv-deep', bg: '--uv-offwhite', use: 'Body text on the page', min: 4.5 },
  { fg: '--uv-deep', bg: '--uv-white', use: 'Body text on a card', min: 4.5 },
  { fg: '--uv-text-muted', bg: '--uv-white', use: 'Hints on a card', min: 4.5 },
  { fg: '--uv-text-muted', bg: '--uv-offwhite', use: 'Hints on the page', min: 4.5 },
  { fg: '--uv-deep', bg: '--uv-lime', use: 'The action button', min: 4.5 },
  { fg: '--uv-deep', bg: '--uv-lime-wash', use: 'Done and selected states', min: 4.5 },
  { fg: '--uv-offwhite', bg: '--uv-deep', use: 'Text on deep green', min: 4.5 },
  { fg: '--uv-lime', bg: '--uv-deep', use: 'Lime accents on deep green', min: 4.5 },
  { fg: '--uv-danger', bg: '--uv-white', use: 'Error text', min: 4.5 },
  { fg: '--uv-input-border', bg: '--uv-white', use: 'A field outline (non-text, WCAG 1.4.11)', min: 3 },
] as const;

const NEVER_TEXT = { fg: '--uv-lime', bg: '--uv-offwhite', use: 'Lime on a light ground: never text (the brand rule)' } as const;

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** A token's value, resolved through `var()` chains by the browser. */
function useToken() {
  const [read, setRead] = useState<((name: string) => string) | null>(null);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setRead(() => (name: string) => style.getPropertyValue(name).trim());
  }, []);
  return read;
}

function Swatch({ fg, bg, children }: { fg: string; bg: string; children: ReactNode }) {
  return (
    <div style={{ background: `var(${bg})`, color: `var(${fg})`, borderRadius: 'var(--uv-radius-sm)', padding: '12px 16px', border: '1px solid var(--uv-border)' }}>
      {children}
    </div>
  );
}

function Tokens() {
  const token = useToken();
  if (!token) return null;
  const never = contrast(token(NEVER_TEXT.fg), token(NEVER_TEXT.bg));
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
      <h2 style={{ margin: 0 }}>Colour pairs</h2>
      {PAIRS.map((p) => {
        const ratio = contrast(token(p.fg), token(p.bg));
        // A non-text pair (WCAG 1.4.11, 3:1) is shown as what it is, an outline, with its words in body text.
        if (p.min < 4.5)
          return (
            <div key={`${p.fg}${p.bg}`} style={{ background: `var(${p.bg})`, border: `2px solid var(${p.fg})`, borderRadius: 'var(--uv-radius-sm)', padding: '12px 16px', color: 'var(--uv-deep)' }}>
              <strong>{p.use}</strong> · {p.fg} on {p.bg} ·{' '}
              <span data-testid="ratio" data-ratio={ratio.toFixed(2)} data-min={p.min}>
                {ratio.toFixed(2)}:1
              </span>
            </div>
          );
        return (
          <Swatch key={`${p.fg}${p.bg}`} fg={p.fg} bg={p.bg}>
            <strong>{p.use}</strong> · {p.fg} on {p.bg} ·{' '}
            <span data-testid="ratio" data-ratio={ratio.toFixed(2)} data-min={p.min}>
              {ratio.toFixed(2)}:1
            </span>
          </Swatch>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden="true" style={{ width: 48, height: 32, borderRadius: 8, background: `var(${NEVER_TEXT.fg})`, outline: '8px solid var(--uv-offwhite)' }} />
        <span data-testid="never" data-ratio={never.toFixed(2)}>
          {NEVER_TEXT.use}: {never.toFixed(2)}:1
        </span>
      </div>
    </div>
  );
}

const meta = { title: 'Foundations/Tokens', component: Tokens } satisfies Meta<typeof Tokens>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every pair the components use meets its minimum; lime on a light ground fails, which is why it's never text. */
export const ColourPairs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ratios = await waitFor(() => {
      const r = canvas.getAllByTestId('ratio');
      if (r.length !== PAIRS.length) throw new Error('not rendered yet');
      return r;
    });
    for (const r of ratios) await expect(Number(r.dataset.ratio)).toBeGreaterThanOrEqual(Number(r.dataset.min));
    await expect(Number(canvas.getByTestId('never').dataset.ratio)).toBeLessThan(3);
  },
};
