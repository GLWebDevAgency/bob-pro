import { describe, expect, it } from 'vitest';
import { clampAgentAutonomy } from './autonomy-entitlements';

describe('clampAgentAutonomy', () => {
  it('utilise le droit courant par défaut', () => {
    expect(clampAgentAutonomy(undefined, 'confirm_all')).toBe('confirm_all');
    expect(clampAgentAutonomy(undefined, 'confirm_outbound')).toBe('confirm_outbound');
  });

  it('autorise un mode plus prudent que le droit acheté', () => {
    expect(clampAgentAutonomy('confirm_all', 'auto')).toBe('confirm_all');
  });

  it('plafonne un mode demandé au-dessus du droit acheté', () => {
    expect(clampAgentAutonomy('auto', 'confirm_all')).toBe('confirm_all');
    expect(clampAgentAutonomy('auto', 'confirm_outbound')).toBe('confirm_outbound');
  });
});
