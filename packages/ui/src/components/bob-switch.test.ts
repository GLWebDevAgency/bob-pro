/**
 * BobSwitch — logique pure (Lot 4). La sélection utilisateur vit sur theme.ink (arbitrage
 * SÉLECTION : l'indigo reste à Bob, le vert à la récompense) ; le pouce BASCULE sans
 * animation (fail-closed par construction).
 */
import { describe, expect, it } from 'vitest';
import {
  BOB_SWITCH_PADDING,
  BOB_SWITCH_THUMB_SIZE,
  BOB_SWITCH_TRACK_WIDTH,
  bobSwitchThumbOffset,
  bobSwitchTrackColor,
} from './bob-switch.logic';

const PALETTE = { ink: '#0C2340', trackOff: '#EFF2F6' } as const;

describe('bobSwitchTrackColor', () => {
  it('ON → theme.ink (sélection utilisateur = ink PARTOUT, jamais le vert plateforme)', () => {
    expect(bobSwitchTrackColor(true, PALETTE)).toBe('#0C2340');
  });

  it('OFF → piste neutre segmentedTrack', () => {
    expect(bobSwitchTrackColor(false, PALETTE)).toBe('#EFF2F6');
  });
});

describe('bobSwitchThumbOffset', () => {
  it('OFF → pouce au bord gauche (padding 3)', () => {
    expect(bobSwitchThumbOffset(false)).toBe(BOB_SWITCH_PADDING);
  });

  it('ON → pouce au bord droit (48 − 22 − 3 = 23)', () => {
    expect(bobSwitchThumbOffset(true)).toBe(
      BOB_SWITCH_TRACK_WIDTH - BOB_SWITCH_THUMB_SIZE - BOB_SWITCH_PADDING,
    );
    expect(bobSwitchThumbOffset(true)).toBe(23);
  });
});
