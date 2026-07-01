import { describe, it, expect } from 'vitest';
import { requiresConfirmation, isSafetyFloor, riskTierOf, type AgentAutonomy } from './autonomy';
import { type RiskTier } from '../tools/tool';

const MODES: AgentAutonomy[] = ['confirm_all', 'confirm_outbound', 'auto'];
const tool = (over: Partial<{ mutating: boolean; outbound: boolean; safetyFloor: boolean }> = {}) => ({
  mutating: true,
  outbound: false,
  ...over,
});

describe('requiresConfirmation', () => {
  it('lecture (non mutante) : jamais de confirmation', () => {
    for (const m of MODES) expect(requiresConfirmation(tool({ mutating: false }), m)).toBe(false);
  });

  it('interne réversible non sensible : confirmé en confirm_all, direct en confirm_outbound/auto', () => {
    const t = tool(); // mutante, non-outbound, non-floor
    expect(requiresConfirmation(t, 'confirm_all')).toBe(true);
    expect(requiresConfirmation(t, 'confirm_outbound')).toBe(false);
    expect(requiresConfirmation(t, 'auto')).toBe(false);
  });

  it('PLANCHER outbound (envoi tiers) : confirmé dans TOUS les modes, même auto', () => {
    const t = tool({ outbound: true });
    for (const m of MODES) expect(requiresConfirmation(t, m)).toBe(true);
  });

  it('PLANCHER safetyFloor (irréversible légal/fiscal, purge) : confirmé même en auto', () => {
    const t = tool({ safetyFloor: true });
    for (const m of MODES) expect(requiresConfirmation(t, m)).toBe(true);
  });
});

describe('isSafetyFloor', () => {
  it('= outbound OU safetyFloor', () => {
    expect(isSafetyFloor(tool())).toBe(false);
    expect(isSafetyFloor(tool({ outbound: true }))).toBe(true);
    expect(isSafetyFloor(tool({ safetyFloor: true }))).toBe(true);
  });
});

describe('riskTierOf', () => {
  it('utilise riskTier explicite s’il est fourni', () => {
    const tiers: RiskTier[] = ['read', 'draft', 'reversible', 'accounting', 'outbound', 'fiscal'];
    for (const t of tiers) expect(riskTierOf({ mutating: true, outbound: false, riskTier: t })).toBe(t);
  });

  it('dérive des booléens quand riskTier est absent', () => {
    expect(riskTierOf({ mutating: false, outbound: false })).toBe('read');
    expect(riskTierOf({ mutating: true, outbound: true })).toBe('outbound');
    expect(riskTierOf({ mutating: true, outbound: false, safetyFloor: true })).toBe('accounting');
    expect(riskTierOf({ mutating: true, outbound: false })).toBe('reversible');
  });
});

describe('riskTier -> plancher / confirmation', () => {
  const withTier = (riskTier: RiskTier) => ({ mutating: true, outbound: false, riskTier });

  it('accounting / outbound / fiscal sont au plancher (confirmés même en auto)', () => {
    for (const t of ['accounting', 'outbound', 'fiscal'] as RiskTier[]) {
      expect(isSafetyFloor(withTier(t))).toBe(true);
      for (const m of MODES) expect(requiresConfirmation(withTier(t), m)).toBe(true);
    }
  });

  it('draft / reversible ne sont PAS au plancher (directs hors confirm_all)', () => {
    for (const t of ['draft', 'reversible'] as RiskTier[]) {
      expect(isSafetyFloor(withTier(t))).toBe(false);
      expect(requiresConfirmation(withTier(t), 'confirm_all')).toBe(true);
      expect(requiresConfirmation(withTier(t), 'auto')).toBe(false);
    }
  });
});
