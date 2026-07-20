/**
 * BottomTabBar — barre d'onglets pill flottante (COMPONENT_SPECS.md §14).
 * Pill surface radius 22, ombre e2 + bordure carte (Android), 5 items colonne
 * (icône 23 stroke 1.9 + label 10/600). Actif = rôle navigation.active
 * (assistant = navigation.assistantActive), inactif = navigation.inactive — les
 * trois paires sont certifiées AA sur surface ; voir bottom-tab-bar.logic.
 *
 * `floating` : conteneur absolu bas + fondu bg (patterns.bottomTabBar.fade) pour que
 * le contenu défile dessous en s'estompant — le pill ne colle jamais aux bords.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { patterns, shadowNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { tabColor } from './bottom-tab-bar.logic';

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
  const { colors, controls, radius } = useTheme();

  const pill = (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: radius.cardXl,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingVertical: 8,
        paddingHorizontal: 6,
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
              minHeight: 44,
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
