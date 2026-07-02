import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TextStyle } from 'react-native';
import {
  themes,
  defaultTheme,
  gradients,
  neutrals,
  semantic,
  controls,
  overlays,
  radius,
  fonts,
  type as typeScale,
  type ThemeName,
  type BrandTheme,
} from '@bob/tokens';
import { DEFAULT_PERSONALITY, normalizePersonality, type Personality } from '@bob/i18n';

export type { Personality };
export type Density = 'Cockpit' | 'Zen';

/** Port de persistance des préférences — l'app fournit l'adaptateur (SecureStore, localStorage…). */
export interface PrefsStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

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

export interface ThemeContextValue {
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
  controls: typeof controls;
  overlays: typeof overlays;
  radius: typeof radius;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: PrefsStorage;
}) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    if (!storage) return;
    let active = true;
    storage
      .read(PREFS_KEY)
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
            /* prefs corrompues : défauts conservés */
          }
        }
      })
      .catch(() => {
        /* stockage indisponible : défauts conservés */
      });
    return () => {
      active = false;
    };
  }, [storage]);

  const update = (patch: Partial<Prefs>): void => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      void storage?.write(PREFS_KEY, JSON.stringify(next)).catch(() => undefined);
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
      controls,
      overlays,
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

type ScaleKey = keyof typeof typeScale;

/** Suffixes expo-google-fonts par poids (SchibstedGrotesk_800ExtraBold, HankenGrotesk_600SemiBold…). */
const WEIGHT_SUFFIX: Record<string, string> = {
  '400': '400Regular',
  '500': '500Medium',
  '600': '600SemiBold',
  '700': '700Bold',
  '800': '800ExtraBold',
};

/**
 * Convertit une entrée de l'échelle typographique des tokens en TextStyle RN.
 * fontFamily cible les familles chargées par expo-google-fonts (une par poids —
 * exigence Android) ; fontWeight reste en secours si la police n'est pas chargée.
 */
export function font(key: ScaleKey): TextStyle {
  const t = typeScale[key];
  const weight = String(t.weight);
  const base = (t.family === 'display' ? fonts.display : fonts.text).replace(/\s+/g, '');
  const suffix = WEIGHT_SUFFIX[weight];
  const style: TextStyle = {
    fontSize: t.size,
    fontWeight: weight as TextStyle['fontWeight'],
    ...(suffix !== undefined ? { fontFamily: `${base}_${suffix}` } : {}),
  };
  if ('tracking' in t && typeof t.tracking === 'number') style.letterSpacing = t.tracking;
  if ('uppercase' in t && t.uppercase) style.textTransform = 'uppercase';
  return style;
}

/** Parse "linear-gradient(168deg, #a 0%, #b 58%, #c 100%)" pour expo-linear-gradient. */
export function parseGradient(css: string): {
  colors: [string, string, ...string[]];
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  const hexes = css.match(/#[0-9a-fA-F]{3,8}/g) ?? [neutrals.ink900, neutrals.ink600];
  const colors = (hexes.length >= 2 ? hexes : [hexes[0] ?? neutrals.ink900, hexes[0] ?? neutrals.ink600]) as [
    string,
    string,
    ...string[],
  ];
  return { colors, start: { x: 0, y: 0 }, end: { x: 0.4, y: 1 } };
}
