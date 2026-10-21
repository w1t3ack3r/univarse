// Spec 0017 PB2's check, shared with spec 0019's stack probe (B6) so both prove the same property the same way.

/** Tenant rows as read, against what that tenant must see: exactly its ids, its values, its count. */
export function tenantRowProblems(
  rows: { tenantId: string; type: string }[],
  expected: { tenantId: string; values: string[] },
): string[] {
  const problems: string[] = [];
  if (rows.some((r) => r.tenantId !== expected.tenantId)) problems.push('a row of another tenant');
  const values = rows.map((r) => r.type).sort();
  if (JSON.stringify(values) !== JSON.stringify([...expected.values].sort()))
    problems.push('the wrong values');
  if (rows.length !== expected.values.length)
    problems.push(`${rows.length} rows, expected ${expected.values.length}`);
  return problems;
}
