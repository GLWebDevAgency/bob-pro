import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  themes,
  defaultTheme,
  gradients,
  neutrals,
  semantic,
  radius,
  type ThemeName,
  type BrandTheme,
} from '@bob/tokens';
import { DEFAULT_PERSONALITY, normalizePersonality, type Personality } from '@bob/i18n';

export type { Personality };
export type Density = 'Cockpit' | 'Zen';

interface Prefs {
  themeName: ThemeName;
  personality: Personality;
  density: Density;
}

const DEFAULT_PREFS: Prefs = {
  themeName: defaultTheme,
  personality: DEFAULT_PERSONALITY,
  density: 'Cockpit',
};
const PREFS_KEY = 'bob.prefs.v1';

interface ThemeContextValue {
  theme: BrandTheme;
  themeName: ThemeName;
  grad: ReturnType<typeof gradients>;
  personality: Personality;
  density: Density;
  setThemeName: (n: ThemeName) => void;
  setPersonality: (p: Personality) => void;
  setDensity: (d: Density) => void;
  colors: typeof neutrals;
  semantic: typeof semantic;
  radius: typeof radius;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(PREFS_KEY)
      .then((raw) => {
        if (active && raw) {
          try {
            const stored = JSON.parse(raw) as Partial<Prefs> & { personality?: unknown };
            setPrefs((p) => ({
              ...p,
              ...stored,
              // Migration legacy 'Pote'/'Pro'/'Direct' → ids canoniques @bob/i18n.
              personality: normalizePersonality(stored.personality ?? p.personality),
            }));
          } catch {
            /* prefs corrompues : on garde les valeurs par défaut */
          }
        }
      })
      .catch(() => {
        /* secure-store indisponible : on garde les défauts */
      });
    return () => {
      active = false;
    };
  }, []);

  const update = (patch: Partial<Prefs>): void => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      void SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  const theme = themes[prefs.themeName];

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeName: prefs.themeName,
      grad: gradients(theme),
      personality: prefs.personality,
      density: prefs.density,
      setThemeName: (n) => update({ themeName: n }),
      setPersonality: (p) => update({ personality: p }),
      setDensity: (d) => update({ density: d }),
      colors: neutrals,
      semantic,
      radius,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme doit être utilisé dans un ThemeProvider');
  return ctx;
}

/** Parse "linear-gradient(168deg, #a 0%, #b 58%, #c 100%)" en { colors, start, end } pour expo-linear-gradient. */
export function parseGradient(css: string): { colors: [string, string, ...string[]]; start: { x: number; y: number }; end: { x: number; y: number } } {
  const hexes = css.match(/#[0-9a-fA-F]{3,8}/g) ?? ['#0C2340', '#163763'];
  const colors = (hexes.length >= 2 ? hexes : [hexes[0] ?? '#0C2340', hexes[0] ?? '#163763']) as [string, string, ...string[]];
  return { colors, start: { x: 0, y: 0 }, end: { x: 0.4, y: 1 } };
}
