/**
 * Statiques de la barre LIVRÉE (PERF-13 borné) — preuves en LITTÉRAUX : les valeurs portées
 * sont EXACTEMENT celles que la géométrie normative du socle produit au repos (progress 0),
 * sur les deux OS, et la bordure est celle de la palette validée AA — jamais un chiffre libre.
 */
import { describe, expect, it } from 'vitest';
import { surfaceTint } from '@bob/tokens';
import { tabBarGeometry } from './bob-tab-bar.logic';
import { deliveredPillStatics } from './bottom-tab-bar.statics';

describe('deliveredPillStatics — géométrie du socle au repos, en littéraux', () => {
  it.each(['ios', 'android'] as const)(
    '%s : pressable 50, rythme 4, rangée 4, bordure 1, rayon 30 (= rectangle mesuré 60 / 2)',
    (platform) => {
      const statics = deliveredPillStatics(platform, 'light');
      expect(statics.pressableMinHeight).toBe(50);
      expect(statics.paddingVertical).toBe(4);
      expect(statics.paddingHorizontal).toBe(4);
      expect(statics.borderWidth).toBe(1);
      expect(statics.borderRadius).toBe(30);
    },
  );

  it('coïncide EXACTEMENT avec tabBarGeometry(0) du socle — la formule, pas une recopie', () => {
    const geometry = tabBarGeometry(0, { platform: 'ios', windowWidth: 393, tabCount: 5 });
    const statics = deliveredPillStatics('ios', 'light');
    expect(statics.pressableMinHeight).toBe(geometry.pressableHeight);
    expect(statics.paddingVertical).toBe(geometry.outerRhythm);
    expect(statics.borderRadius).toBe(geometry.borderRadius);
  });

  it('bordure = la palette VALIDÉE (neutral.border), par apparence — en littéraux', () => {
    expect(deliveredPillStatics('ios', 'light').borderColor).toBe('#E0E6EE');
    expect(deliveredPillStatics('ios', 'dark').borderColor).toBe('#1E3D66');
    expect(deliveredPillStatics('ios', 'light').borderColor).toBe(
      surfaceTint.light.neutral.border,
    );
  });
});
