import { describe, expect, it } from 'vitest';
import { NIGERIAN_STATES } from './nigerian-states.js';

describe('the states (spec 0033 Q7)', () => {
  it('has 36 states and the FCT, once each', () => {
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(new Set(NIGERIAN_STATES).size).toBe(37);
  });
});
