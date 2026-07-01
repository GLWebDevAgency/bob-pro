import { describe, it, expect } from 'vitest';
import { challengeFor } from './confirmation';
import { type RiskTier } from '../tools/tool';

const tool = (riskTier: RiskTier) => ({ mutating: true, outbound: false, riskTier });

describe('challengeFor', () => {
  it('lecture : aucune confirmation', () => {
    expect(challengeFor({ mutating: false, outbound: false, riskTier: 'read' }, 'confirm_all').kind).toBe('none');
  });

  it('réversible : none en auto, tap en confirm_all', () => {
    expect(challengeFor(tool('reversible'), 'auto').kind).toBe('none');
    expect(challengeFor(tool('reversible'), 'confirm_all').kind).toBe('tap');
  });

  it('outbound : tap dans tous les modes (plancher)', () => {
    for (const m of ['confirm_all', 'confirm_outbound', 'auto'] as const) {
      expect(challengeFor(tool('outbound'), m).kind).toBe('tap');
    }
  });

  it('fiscal : double validation fiscale même en auto', () => {
    const c = challengeFor(tool('fiscal'), 'auto');
    expect(c.kind).toBe('fiscal');
  });

  it('accounting avec montant : re-confirmation du montant exact', () => {
    const c = challengeFor(tool('accounting'), 'auto', { amountCents: 132000 });
    expect(c.kind).toBe('amount');
    if (c.kind === 'amount') expect(c.expectedCents).toBe(132000);
  });

  it('accounting sans montant exploitable : retombe sur tap', () => {
    expect(challengeFor(tool('accounting'), 'auto', {}).kind).toBe('tap');
    expect(challengeFor(tool('accounting'), 'auto', { amountCents: 'x' }).kind).toBe('tap');
  });
});
