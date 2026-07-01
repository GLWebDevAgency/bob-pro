import { describe, it, expect } from 'vitest';
import { ActionPolicy, type ActionContext, type ToolFacts } from './permissions';

const ctx = (over: Partial<ToolFacts> = {}): ActionContext => ({
  tool: { name: 'encaisser_facture', mutating: true, outbound: false, compliance: 'high', ...over },
  args: {},
  mode: 'live',
});

describe('ActionPolicy', () => {
  it('allowAll autorise tout', () => {
    expect(ActionPolicy.allowAll().decide(ctx()).allow).toBe(true);
  });

  it('deny est prioritaire, même sur une allowlist', () => {
    const p = new ActionPolicy({ deny: ['encaisser_facture'], allow: ['encaisser_facture'] });
    expect(p.decide(ctx()).allow).toBe(false);
  });

  it('readOnly bloque les outils modifiants et laisse passer la lecture', () => {
    const p = new ActionPolicy({ readOnly: true });
    expect(p.decide(ctx({ mutating: true })).allow).toBe(false);
    expect(p.decide(ctx({ name: 'factures_impayees', mutating: false })).allow).toBe(true);
  });

  it('allowlist stricte : hors liste => refus', () => {
    const p = new ActionPolicy({ allow: ['factures_impayees'] });
    expect(p.decide(ctx({ name: 'factures_impayees', mutating: false })).allow).toBe(true);
    expect(p.decide(ctx({ name: 'encaisser_facture' })).allow).toBe(false);
  });

  it('plafond de conformité : refuse au-dessus, autorise en dessous, allowlist déroge', () => {
    const p = new ActionPolicy({ maxCompliance: 'medium' });
    expect(p.decide(ctx({ compliance: 'high' })).allow).toBe(false);
    expect(p.decide(ctx({ compliance: 'low' })).allow).toBe(true);
    const p2 = new ActionPolicy({ maxCompliance: 'low', allow: ['encaisser_facture'] });
    expect(p2.decide(ctx({ compliance: 'high' })).allow).toBe(true);
  });

  it('règle custom : la première qui refuse gagne (avec sa raison)', () => {
    const p = new ActionPolicy({ rules: [() => ({ allow: false, reason: 'nope' })] });
    const d = p.decide(ctx({ compliance: 'low' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('nope');
  });
});
