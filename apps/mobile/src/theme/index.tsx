import type { ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { ThemeProvider as UiThemeProvider, type PrefsStorage } from '@bob/ui';

/**
 * Adaptateur app : le ThemeProvider partagé vit dans @bob/ui (claim C03) ;
 * le mobile ne fournit que la persistance SecureStore. L'API historique
 * (useTheme, parseGradient, types) est ré-exportée à l'identique.
 */
const secureStorage: PrefsStorage = {
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) => SecureStore.setItemAsync(key, value),
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  return <UiThemeProvider storage={secureStorage}>{children}</UiThemeProvider>;
}

export { useTheme, parseGradient, font } from '@bob/ui';
export type { Personality, Density, ThemeContextValue } from '@bob/ui';
