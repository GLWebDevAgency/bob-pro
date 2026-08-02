/**
 * BottomTabBar — barre d'onglets pill flottante (COMPONENT_SPECS.md §14).
 * 5 items colonne (icône 23 stroke 1.9 + label 10/600). Actif = rôle navigation.active
 * (assistant = navigation.assistantActive), inactif = navigation.inactive — les
 * trois paires sont certifiées AA sur surface ; voir bottom-tab-bar.logic.
 *
 * GÉOMÉTRIE/TEINTE DE LA PILULE (Lot 1, PERF-13 borné) : les statiques VALIDÉS de la barre
 * portée (`bob-tab-bar.logic`, au repos) remplacent les constantes historiques — pilule
 * pleinement ronde (rayon = rectangle mesuré / 2), rythme 4/4, bordure de la palette AA.
 * RIEN d'animé, rien de comportemental : tout ce qui bouge attend le flag
 * `mobile_tabs_experiment_v1` — voir bottom-tab-bar.statics.ts.
 *
 * `floating` : conteneur absolu bas + fondu bg (patterns.bottomTabBar.fade) pour que
 * le contenu défile dessous en s'estompant — le pill ne colle jamais aux bords.
 */
import type { ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { patterns, shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { tabColor } from './bottom-tab-bar.logic';
import { deliveredPillStatics } from './bottom-tab-bar.statics';

const ICON_SIZE = 23;
const TAB_BAR = patterns.bottomTabBar;

/** Icône injectée : nœud prêt à l'emploi, ou render-prop recevant couleur/taille du slot. */
export type BottomTabIcon =
  | ReactNode
  | ((state: { readonly color: string; readonly size: number }) => ReactNode);

export interface BottomTabItem {
  readonly key: string;
  readonly label: string;
  readonly icon: BottomTabIcon;
}

export interface BottomTabBarProps {
  readonly items: readonly BottomTabItem[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  /** Marge basse (safe-area) — 26 dans le proto. */
  readonly insetBottom?: number;
  /** true = conteneur absolu bas + fondu de fond (écrans) ; false = pill nu (galerie). */
  readonly floating?: boolean;
}

export function BottomTabBar({
  items,
  activeKey,
  onSelect,
  insetBottom = TAB_BAR.padding[2],
  floating = false,
}: BottomTabBarProps) {
  const { colors, appearance } = useTheme();
  const statics = deliveredPillStatics(Platform.OS === 'android' ? 'android' : 'ios', appearance);

  const pill = (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: statics.borderRadius,
        borderWidth: statics.borderWidth,
        borderColor: statics.borderColor,
        paddingVertical: statics.paddingVertical,
        paddingHorizontal: statics.paddingHorizontal,
        ...(floating ? {} : { marginBottom: insetBottom }),
        ...shadowNative.e2,
      }}
    >
      {items.map((item) => {
        const active = item.key === activeKey;
        const color = tabColor(item.key, active);
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(item.key)}
            style={{
              flex: 1,
              minHeight: statics.pressableMinHeight,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            <View
              style={{
                width: ICON_SIZE,
                height: ICON_SIZE,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {typeof item.icon === 'function' ? item.icon({ color, size: ICON_SIZE }) : item.icon}
            </View>
            <Text style={[font('meta'), { fontSize: 10, color }]} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (!floating) return pill;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[...TAB_BAR.fade] as [string, string, ...string[]]}
        locations={[...TAB_BAR.fadeLocations] as [number, number, ...number[]]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        pointerEvents="box-none"
        style={{
          paddingTop: TAB_BAR.padding[0],
          paddingHorizontal: TAB_BAR.padding[1],
          paddingBottom: insetBottom,
        }}
      >
        {pill}
      </View>
    </View>
  );
}
