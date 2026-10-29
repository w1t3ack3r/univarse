// Spec 0026 SB6: what the accessibility proof requires, as pure functions (a11y-proof.test.mjs tests them).

export const EXPECTED = { LimeTextOnOffWhite: 'color-contrast', IconButtonWithoutName: 'button-name' };

/** The failures, per story, from Vitest's JSON report: each story's name and the axe rule ids in its messages. */
export function failures(report) {
  const out = {};
  for (const file of report.testResults ?? [])
    for (const t of file.assertionResults ?? []) {
      const story = String(t.title ?? '').replace(/\s+/g, '');
      const rules = [...new Set((t.failureMessages ?? []).join('\n').match(/\b[a-z]+(?:-[a-z]+)+\b/g) ?? [])];
      out[story] = { status: t.status, rules };
    }
  return out;
}

/** What is wrong with a proof run, or nothing. */
export function problems(status, found) {
  const p = [];
  if (status === 0) p.push('the proof passed: the accessibility gate is not failing broken stories');
  for (const [story, rule] of Object.entries(EXPECTED)) {
    const f = Object.entries(found).find(([name]) => name.toLowerCase() === story.toLowerCase())?.[1];
    if (!f) p.push(`${story}: not run`);
    else if (f.status !== 'failed') p.push(`${story}: ${f.status}, not failed`);
    else if (!f.rules.includes(rule)) p.push(`${story}: failed, but not for ${rule} (found: ${f.rules.join(', ') || 'no rule'})`);
  }
  const extra = Object.keys(found).filter((n) => !Object.keys(EXPECTED).some((s) => s.toLowerCase() === n.toLowerCase()));
  if (extra.length) p.push(`unexpected proof stories: ${extra.join(', ')}`);
  return p;
}
