/**
 * ISO-RENDU de la promotion ScreenHeader → BackHeader (Lot 0, plan DA 01/08). Deux preuves :
 *  1. IDENTITÉ — le module local est un PUR réexport : `ScreenHeader` est LA MÊME référence
 *     de composant que `BackHeader` de @bob/ui.
 *  2. ARBRE — sur les mêmes props (avec et sans subtitle/action), le composant promu rend un
 *     arbre STRICTEMENT égal à l'ancienne implémentation locale, FIGÉE ici en fixture (copie
 *     verbatim d'avant-promotion — ChevronLeftIcon d'icons.tsx compris : le chevron du kit
 *     doit être indiscernable du chevron local, nœud SVG pour nœud SVG).
 * Les deux arbres traversent le VRAI InnerScreenHeader et le VRAI ThemeProvider de @bob/ui
 * (aliasé source) ; react-native / svg / safe-area sont des doublures string.
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackHeader, InnerScreenHeader, ThemeProvider, font, useTheme } from '@bob/ui';
import { ScreenHeader } from './screen-header';
import { ChevronLeftIcon } from './icons';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue } = vi.hoisted(() => {
  class FakeAnimatedValue {
    private value: number;
    constructor(value: number) {
      this.value = value;
    }
    interpolate(): number {
      return this.value;
    }
    setValue(value: number): void {
      this.value = value;
    }
    stopAnimation(): void {}
  }
  return { FakeAnimatedValue };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    // Voile v2 en pied d'InnerScreenHeader (Lot 1) : la préférence de transparence reste
    // NON RÉSOLUE — fail-closed, le voile plat teinté identique dans les DEUX arbres.
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    setAccessibilityFocus: vi.fn(),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    Text: 'Animated.Text',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, ease: {}, cubic: {} },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
  Rect: 'Rect',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

/* ────────────────────────────────────────────────────────────────────────────────
 * FIXTURE — l'ancienne implémentation LOCALE de ScreenHeader, copiée VERBATIM depuis
 * apps/mobile/src/components/screen-header.tsx tel qu'il était AVANT la promotion
 * (HEAD 64adf909). Ne pas « améliorer » : c'est l'étalon de l'iso-rendu.
 * ──────────────────────────────────────────────────────────────────────────────── */
interface LegacyProps {
  backLabel: string;
  onBack: () => void;
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

function LegacyScreenHeader({ backLabel, onBack, eyebrow, title, subtitle, action }: LegacyProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          hitSlop={8}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            alignSelf: 'flex-start',
            minHeight: 44,
            // Press feedback standard (passe feel 18/07) — un retour qui répond au doigt.
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>{backLabel}</Text>
        </Pressable>
      </View>
      <InnerScreenHeader
        eyebrow={eyebrow}
        title={title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        {...(action !== undefined ? { action } : {})}
        compact
      />
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────────── */

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

/** Arbre normalisé (JSON round-trip) : les props-fonctions — closures neuves par instance,
 *  dont les style-fonctions de Pressable — sont retirées ; balises, props sérialisables et
 *  styles restent comparés à l'unité près. */
function normalizedTree(renderer: ReactTestRenderer): unknown {
  return JSON.parse(JSON.stringify(renderer.toJSON())) as unknown;
}

const PROPS = {
  backLabel: 'Clients',
  onBack: () => {},
  eyebrow: 'FICHE',
  title: 'Mairie de Lyon',
} as const;

describe('ScreenHeader — promotion @bob/ui (BackHeader, iso-rendu)', () => {
  it('le module local est un PUR réexport : même référence de composant que BackHeader', () => {
    expect(ScreenHeader).toBe(BackHeader);
  });

  it('props complètes (subtitle + action) : arbre STRICTEMENT identique à l’implémentation locale', () => {
    const promoted = render(
      <ScreenHeader {...PROPS} subtitle="3 chantiers en cours" action={<View />} />,
    );
    const legacy = render(
      <LegacyScreenHeader {...PROPS} subtitle="3 chantiers en cours" action={<View />} />,
    );
    const promotedTree = normalizedTree(promoted);
    // Témoin : l'arbre porte le retour, le titre ET le chevron SVG.
    const serialized = JSON.stringify(promotedTree);
    expect(serialized).toContain('Clients');
    expect(serialized).toContain('Mairie de Lyon');
    expect(serialized).toContain('M15 6l-6 6 6 6');
    expect(promotedTree).toEqual(normalizedTree(legacy));
  });

  it('props minimales (sans subtitle ni action) : arbre identique aussi', () => {
    const promoted = render(<ScreenHeader {...PROPS} />);
    const legacy = render(<LegacyScreenHeader {...PROPS} />);
    const promotedTree = normalizedTree(promoted);
    expect(JSON.stringify(promotedTree)).toContain('FICHE');
    expect(promotedTree).toEqual(normalizedTree(legacy));
  });
});
