/**
 * GlassPanelDark — recette figée du verre sombre (Lot 5) : white07 / bord white10 /
 * radius 18, en LITTÉRAUX (un mutant qui échange les deux voiles blancs ou décale le
 * radius meurt ici — c'est la triple copie du diagnostic qu'on fige).
 */
import { describe, expect, it } from 'vitest';
import { GLASS_PANEL_DARK_RADIUS, glassPanelDarkStyle } from './glass-panel-dark.logic';

describe('glassPanelDarkStyle — la matière verre sombre, au pixel', () => {
  it('fond white07, bord 1 white10, radius 18', () => {
    expect(glassPanelDarkStyle()).toEqual({
      backgroundColor: 'rgba(255,255,255,.07)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,.1)',
      borderRadius: 18,
    });
    expect(GLASS_PANEL_DARK_RADIUS).toBe(18);
  });
});
