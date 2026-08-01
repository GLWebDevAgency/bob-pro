/**
 * HeaderIconButton — bouton d'action de header (Lot 0, plan DA 01/08) : squircle 44×44
 * radius 13 (l'arbitrage entre le squircle 42 de clients et le rond 44 de chantiers),
 * aplat ink du thème + ombre e2, icône injectée (aucune lib d'icônes), press scale 0.94,
 * désactivé 0.45. Consommateurs (Lot 4) : clients (+), chantiers — AUCUN migré ici.
 */
import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { shadowNative } from '@bob/tokens';
import { useTheme } from '../theme';
import { headerIconButtonStyle } from './header-icon-button.logic';

export interface HeaderIconButtonProps {
  /** Libellé accessible OBLIGATOIRE — l'icône seule ne dit rien au lecteur d'écran. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  /** Icône injectée (couleur surface côté appelant). */
  readonly children: ReactNode;
  readonly testID?: string;
}

export function HeaderIconButton({
  accessibilityLabel,
  onPress,
  disabled = false,
  children,
  testID,
}: HeaderIconButtonProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      {...(testID !== undefined ? { testID } : {})}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        headerIconButtonStyle({ pressed, disabled, ink: theme.ink }),
        shadowNative.e2,
      ]}
    >
      {children}
    </Pressable>
  );
}
