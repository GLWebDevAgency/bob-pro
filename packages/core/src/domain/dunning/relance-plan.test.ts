import { describe, it, expect } from 'vitest';
import { RelancePlan } from './relance-plan';

describe('RelancePlan', () => {
  it('cadence par defaut : cordial puis escalade jusqu a la mise en demeure', () => {
    const p = RelancePlan.defaultCadence('r1', 'F-2026-0001');
    expect(p.currentTone()).toBe('cordial');
    expect(p.escalate()).toBe('neutre');
    expect(p.escalate()).toBe('ferme');
    expect(p.escalate()).toBe('miseendemeure');
    expect(p.escalate()).toBe('miseendemeure');
  });
});
