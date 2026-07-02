/**
 * BottomTabBar — barre d'onglets flottante (COMPONENT_SPECS.md §14).
 * Conteneur surface radius 22, ombre tabBar, 5 items colonne (icône 23 + label 10/600).
 * Actif = ink900 (assistant = semantic.ai), inactif = slate300 — voir bottom-tab-bar.logic.
 *
 * Note redlines : le « fondu de fond » (dégradé transparent→bg) derrière la barre est
 * volontairement OMIS — il exigerait un littéral rgba (token-lint) et aucun token
 * overlay teinté bg n'existe en v1.2. À réintroduire si un token dédié est ajouté.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { shadowComponentsNative } from '@bob/tokens';
import { font, useTheme } from '../theme';
import { tabColor } from './bottom-tab-bar.logic';

const ICON_SIZE = 23;

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
}

export function BottomTabBar({ items, activeKey, onSelect, insetBottom = 26 }: BottomTabBarProps) {
  const { colors, radius } = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: radius.cardXl,
        paddingVertical: 8,
        paddingHorizontal: 6,
        marginBottom: insetBottom,
        ...shadowComponentsNative.tabBar,
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
}
