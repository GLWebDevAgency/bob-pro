/**
 * StickyActionBar — logique PURE des 2 variantes (Lot 0). Littéraux figés depuis les
 * écrans de référence du plan : facture/new (variante 'bar') et client/[id] ('floating').
 */
import { describe, expect, it } from 'vitest';
import {
  STICKY_FLOATING_ACCENT_WIDTH,
  STICKY_FLOATING_MIN_HEIGHT,
  stickyBarContainerStyle,
  stickyFloatingContainerStyle,
  stickyFloatingPillStyle,
} from './sticky-action-bar.logic';

const palette = { surface: '#FFFFFF', lineSoft: '#F1F4F7' };

describe('stickyBarContainerStyle — variante bar (facture/new)', () => {
  it('surface + borderTop lineSoft + paddings 18/10/insets+12 (littéraux de l’écran de référence)', () => {
    // insets.bottom 34 (iPhone à encoche) : paddingBottom = 34 + 12 = 46.
    expect(stickyBarContainerStyle(34, palette)).toEqual({
      paddingHorizontal: 18,
      paddingTop: 10,
      paddingBottom: 46,
      borderTopWidth: 1,
      borderTopColor: '#F1F4F7',
      backgroundColor: '#FFFFFF',
    });
  });

  it('sans encoche (insets 0) : paddingBottom = 12 exactement', () => {
    expect(stickyBarContainerStyle(0, palette).paddingBottom).toBe(12);
  });
});

describe('stickyFloatingContainerStyle — variante floating (client/[id])', () => {
  it('absolu, latéraux 18, bottom = insets + 14', () => {
    // insets.bottom 34 : bottom = 34 + 14 = 48.
    expect(stickyFloatingContainerStyle(34)).toEqual({
      position: 'absolute',
      left: 18,
      right: 18,
      bottom: 48,
    });
  });
});

describe('stickyFloatingPillStyle — pilule aplat ink + liseré accent', () => {
  it('au repos, sans accent : aplat ink, radius 16, cible 52, AUCUN liseré ni scale', () => {
    expect(stickyFloatingPillStyle({ pressed: false, ink: '#0C2340' })).toEqual({
      backgroundColor: '#0C2340',
      borderRadius: 16,
      minHeight: STICKY_FLOATING_MIN_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingHorizontal: 18,
    });
    expect(STICKY_FLOATING_MIN_HEIGHT).toBe(52);
  });

  it('accentColor → liseré BAS de 3 dans la teinte du standing (le « souligné » du fil rouge)', () => {
    const style = stickyFloatingPillStyle({ pressed: false, ink: '#0C2340', accentColor: '#C8463C' });
    expect(style.borderBottomWidth).toBe(STICKY_FLOATING_ACCENT_WIDTH);
    expect(STICKY_FLOATING_ACCENT_WIDTH).toBe(3);
    expect(style.borderBottomColor).toBe('#C8463C');
    // Jamais un cadre : pas de bord haut/latéraux.
    expect(style.borderTopWidth).toBeUndefined();
    expect(style.borderLeftWidth).toBeUndefined();
  });

  it('pressed → scale 0.98 (press feedback de l’écran de référence), rien d’autre ne bouge', () => {
    const pressed = stickyFloatingPillStyle({ pressed: true, ink: '#0C2340' });
    expect(pressed.transform).toEqual([{ scale: 0.98 }]);
    expect(pressed.backgroundColor).toBe('#0C2340');
  });
});
