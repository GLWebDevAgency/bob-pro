import { describe, expect, it } from 'vitest';

import { U1_CANDIDATE_ACTIONS, isU1CandidateAction } from './rollout';

describe('rollout U1 — bornes techniques candidates fail-closed', () => {
  it('exactement deux candidates U1 (décision de lot, jamais élargie en silence)', () => {
    expect([...U1_CANDIDATE_ACTIONS]).toEqual(['client-creer@1', 'client-modifier@1']);
    expect(Object.isFrozen(U1_CANDIDATE_ACTIONS)).toBe(true);
  });

  it("tout le reste est hors de la borne — y compris une autre version d'une candidate", () => {
    expect(isU1CandidateAction('client-creer', 1)).toBe(true);
    expect(isU1CandidateAction('client-modifier', 1)).toBe(true);
    expect(isU1CandidateAction('client-creer', 2)).toBe(false);
    expect(isU1CandidateAction('facture-emettre', 1)).toBe(false);
    expect(isU1CandidateAction('', 1)).toBe(false);
  });
});
