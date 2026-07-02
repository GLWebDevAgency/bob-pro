import { describe, expect, it } from 'vitest';
import { neutrals, semantic } from '@bob/tokens';
import { ASSISTANT_TAB_KEY, tabColor } from './bottom-tab-bar.logic';

describe('tabColor (§14)', () => {
  it('rend ink900 pour un onglet actif standard', () => {
    expect(tabColor('accueil', true)).toBe(neutrals.ink900);
    expect(tabColor('argent', true)).toBe(neutrals.ink900);
  });

  it("rend semantic.ai pour l'onglet assistant actif", () => {
    expect(tabColor(ASSISTANT_TAB_KEY, true)).toBe(semantic.ai);
  });

  it('rend slate300 pour tout onglet inactif, assistant compris', () => {
    expect(tabColor('accueil', false)).toBe(neutrals.slate300);
    expect(tabColor(ASSISTANT_TAB_KEY, false)).toBe(neutrals.slate300);
  });

  it("expose la clé réservée de l'assistant", () => {
    expect(ASSISTANT_TAB_KEY).toBe('assistant');
  });
});
