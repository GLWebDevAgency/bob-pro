import { describe, expect, it } from 'vitest';
import { resolveColorRole } from '@bob/tokens';
import { ASSISTANT_TAB_KEY, tabColor } from './bottom-tab-bar.logic';

describe('tabColor (§14)', () => {
  it('rend ink900 pour un onglet actif standard', () => {
    expect(tabColor('accueil', true)).toBe(resolveColorRole('navigation.active'));
    expect(tabColor('argent', true)).toBe(resolveColorRole('navigation.active'));
  });

  it("rend semantic.ai pour l'onglet assistant actif", () => {
    expect(tabColor(ASSISTANT_TAB_KEY, true)).toBe(resolveColorRole('navigation.assistantActive'));
  });

  it('rend le rôle de navigation AA pour tout onglet inactif, assistant compris', () => {
    expect(tabColor('accueil', false)).toBe(resolveColorRole('navigation.inactive'));
    expect(tabColor(ASSISTANT_TAB_KEY, false)).toBe(resolveColorRole('navigation.inactive'));
  });

  it("expose la clé réservée de l'assistant", () => {
    expect(ASSISTANT_TAB_KEY).toBe('assistant');
  });
});
