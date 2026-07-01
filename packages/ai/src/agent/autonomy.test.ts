import { describe, it, expect } from 'vitest';
import { requiresConfirmation, isSafetyFloor, type AgentAutonomy } from './autonomy';

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
