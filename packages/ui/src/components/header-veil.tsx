/**
 * HeaderVeil — le voile « header veil » du Lot 0 (plan DA 01/08) : le MÉCANISME UNIQUE
 * ProgressiveBlurBob décliné en trois VARIANTES de montée (AppHeaderNavy, InnerScreenHeader,
 * StickyBackRow). Ce composant est un habillage MINCE : tout le fail-closed vient du
 * mécanisme lui-même (port injecté absent = repli opaque ; préférence transparence inconnue
 * = voile plat opaque ; capacité/surface non déclarées = refus) — rien n'est réouvert ici,
 * et les props d'ouverture gardent leurs défauts FERMÉS.
 *
 * Lot 0 : AUCUN écran ni header n'est modifié — les montées appartiennent au Lot 1
 * (AppHeaderNavy, InnerScreenHeader) et au Lot 0/5 (StickyBackRow, voile optionnel).
 */
import type { ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { ProgressiveBlurBob, type ProgressiveBlurBobViewProps } from './progressive-blur-bob';
import { headerVeilPreset, type HeaderVeilVariant } from './header-veil.logic';

export interface HeaderVeilProps
  extends Pick<
    ProgressiveBlurBobViewProps,
    'layers' | 'renderBlurLayer' | 'renderCapability' | 'surfaceUnder' | 'devShellHeight' | 'onPlan'
  > {
  /** Point de montée arbitré (préréglage anchor/tone/hauteur — header-veil.logic). */
  readonly variant: HeaderVeilVariant;
  /** Hauteur d'enveloppe mesurée par la montée — défaut : le débord du contrat (44). */
  readonly height?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function HeaderVeil({
  variant,
  height,
  layers,
  renderBlurLayer,
  renderCapability,
  surfaceUnder,
  devShellHeight,
  onPlan,
  style,
  testID,
}: HeaderVeilProps): ReactElement {
  const preset = headerVeilPreset(variant);
  return (
    <ProgressiveBlurBob
      anchor={preset.anchor}
      tone={preset.tone}
      height={height ?? preset.height}
      {...(layers !== undefined ? { layers } : {})}
      {...(renderBlurLayer !== undefined ? { renderBlurLayer } : {})}
      {...(renderCapability !== undefined ? { renderCapability } : {})}
      {...(surfaceUnder !== undefined ? { surfaceUnder } : {})}
      {...(devShellHeight !== undefined ? { devShellHeight } : {})}
      {...(onPlan !== undefined ? { onPlan } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(testID !== undefined ? { testID } : {})}
    />
  );
}
