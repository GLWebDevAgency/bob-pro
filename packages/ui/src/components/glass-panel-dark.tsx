/**
 * GlassPanelDark — panneau « verre sombre » du kit (Lot 5, plan DA 01/08) : white07 +
 * bord white10 + radius 18. Résorbe la triple copie de diagnostic.tsx. Le padding reste
 * au consommateur (les trois panneaux du diagnostic n'ont pas la même densité).
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { glassPanelDarkStyle } from './glass-panel-dark.logic';

export interface GlassPanelDarkProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

export function GlassPanelDark({ style, children }: GlassPanelDarkProps) {
  return <View style={[glassPanelDarkStyle(), style]}>{children}</View>;
}
