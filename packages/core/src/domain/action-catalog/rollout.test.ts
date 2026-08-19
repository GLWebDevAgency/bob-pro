import { describe, expect, it } from 'vitest';

import { U1_OPEN_ACTIONS, isU1OpenAction } from './rollout';

describe("rollout U1 — bornes d'ouverture fail-closed", () => {
  it('exactement deux actions ouvertes en U1 (décision de lot, jamais élargie en silence)', () => {
    expect([...U1_OPEN_ACTIONS]).toEqual(['client-creer@1', 'client-modifier@1']);
    expect(Object.isFrozen(U1_OPEN_ACTIONS)).toBe(true);
  });

  it("tout le reste est fermé — y compris une autre version d'une action ouverte", () => {
    expect(isU1OpenAction('client-creer', 1)).toBe(true);
    expect(isU1OpenAction('client-modifier', 1)).toBe(true);
    expect(isU1OpenAction('client-creer', 2)).toBe(false);
    expect(isU1OpenAction('facture-emettre', 1)).toBe(false);
    expect(isU1OpenAction('', 1)).toBe(false);
  });
});
