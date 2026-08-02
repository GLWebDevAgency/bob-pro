/**
 * BobSwitch — logique PURE (Lot 4, plan DA 01/08 : « Switch → BobSwitch tokenisé »).
 * Le Switch natif peignait ses couleurs plateforme (vert iOS) hors tokens ; BobSwitch
 * pose la sélection utilisateur sur theme.ink (arbitrage SÉLECTION : l'indigo reste le
 * canal EXCLUSIF de Bob, le vert la récompense du geste commis).
 */
export const BOB_SWITCH_TRACK_WIDTH = 48;
export const BOB_SWITCH_TRACK_HEIGHT = 28;
export const BOB_SWITCH_THUMB_SIZE = 22;
export const BOB_SWITCH_PADDING = 3;

export interface BobSwitchPalette {
  /** theme.ink — piste à l'état ON (sélection utilisateur). */
  readonly ink: string;
  /** controls.segmentedTrack — piste au repos. */
  readonly trackOff: string;
}

/** Piste — ink quand ON (sélection = ink PARTOUT), piste neutre quand OFF. */
export function bobSwitchTrackColor(value: boolean, palette: BobSwitchPalette): string {
  return value ? palette.ink : palette.trackOff;
}

/** Décalage horizontal du pouce — extrémité droite quand ON. */
export function bobSwitchThumbOffset(value: boolean): number {
  return value
    ? BOB_SWITCH_TRACK_WIDTH - BOB_SWITCH_THUMB_SIZE - BOB_SWITCH_PADDING
    : BOB_SWITCH_PADDING;
}
