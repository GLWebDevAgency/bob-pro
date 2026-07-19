import { describe, it, expect } from 'vitest';
import { proposeSituationFromChantier } from './propose-situation';

describe('proposeSituationFromChantier (B2 — proposé, JAMAIS imposé)', () => {
  it('aucune tâche → null (rien à proposer, jamais un avancement inventé)', () => {
    const r = proposeSituationFromChantier({ tasks: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });
  it('poids égaux par défaut : 2 tâches sur 4 → 50 %', () => {
    const r = proposeSituationFromChantier({
      tasks: [{ done: true }, { done: true }, { done: false }, { done: false }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ percent: 50, doneCount: 2, totalCount: 4 });
  });
  it('pondération explicite : la grosse tâche pèse son poids', () => {
    const r = proposeSituationFromChantier({
      tasks: [
        { done: true, weight: 70 },
        { done: false, weight: 30 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.percent).toBe(70);
  });
  it('arrondi commercial : 1/3 → 33 %', () => {
    const r = proposeSituationFromChantier({ tasks: [{ done: true }, { done: false }, { done: false }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.percent).toBe(33);
  });
  it('tout coché → 100 % ; rien coché → 0 %', () => {
    const all = proposeSituationFromChantier({ tasks: [{ done: true }, { done: true }] });
    if (all.ok) expect(all.value?.percent).toBe(100);
    const none = proposeSituationFromChantier({ tasks: [{ done: false }] });
    if (none.ok) expect(none.value?.percent).toBe(0);
  });
  it('poids invalide (≤ 0, non fini) → VALIDATION', () => {
    expect(proposeSituationFromChantier({ tasks: [{ done: true, weight: 0 }] }).ok).toBe(false);
    expect(proposeSituationFromChantier({ tasks: [{ done: true, weight: -1 }] }).ok).toBe(false);
    expect(proposeSituationFromChantier({ tasks: [{ done: true, weight: Number.NaN }] }).ok).toBe(false);
  });
});
