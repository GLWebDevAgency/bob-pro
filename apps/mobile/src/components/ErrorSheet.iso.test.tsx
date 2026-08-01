/**
 * ISO-RENDU de la promotion ErrorSheet (Lot 0, plan DA 01/08). Deux preuves :
 *  1. IDENTITÉ — le module local est un PUR réexport : `useErrorSheet` est LA MÊME
 *     référence de fonction que celle de @bob/ui (l'écran ne change pas d'un nœud,
 *     trivialement, pour toutes les props possibles).
 *  2. ARBRE — le composant PROMU rend, sur les mêmes props, un arbre STRICTEMENT égal
 *     à celui de l'ancienne implémentation locale, FIGÉE ici en fixture (copie verbatim
 *     d'avant-promotion, mêmes Sheet/Button/font/useTheme réels de @bob/ui aliasé source).
 * `react-native` est mocké au complet (patron sheet.motion.test.tsx de packages/ui) :
 * les deux arbres traversent le VRAI Sheet et le VRAI Button.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { Button, Sheet, ThemeProvider, font, useTheme, useErrorSheet as kitUseErrorSheet } from '@bob/ui';
import { useErrorSheet } from './ErrorSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled, FakeAnimatedValue } = vi.hoisted(() => {
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
  return {
    isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
    FakeAnimatedValue,
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: (...args: unknown[]) =>
      (isReduceMotionEnabled as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    addEventListener: () => ({ remove: vi.fn() }),
    setAccessibilityFocus: vi.fn(),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    Text: 'Animated.Text',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
    loop: (animation: unknown) => ({ start: () => animation, stop: () => {} }),
    sequence: () => ({ start: () => {}, stop: () => {} }),
    delay: () => ({ start: () => {} }),
  },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, ease: {}, cubic: {} },
  Modal: 'Modal',
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
 * FIXTURE — l'ancienne implémentation LOCALE d'ErrorSheet, copiée VERBATIM depuis
 * apps/mobile/src/components/ErrorSheet.tsx tel qu'il était AVANT la promotion
 * (HEAD 64adf909). Ne pas « améliorer » : c'est l'étalon de l'iso-rendu.
 * ──────────────────────────────────────────────────────────────────────────────── */
interface LegacyNotice {
  readonly title: string;
  readonly message?: string;
}

interface LegacyHandle {
  readonly showError: (title: string, message?: string, onDismiss?: () => void) => void;
  readonly errorSheet: ReactNode;
}

function useLegacyErrorSheet(): LegacyHandle {
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState<LegacyNotice | null>(null);
  const onDismissRef = useRef<(() => void) | null>(null);

  const showError = useCallback((title: string, message?: string, onDismiss?: () => void) => {
    onDismissRef.current = onDismiss ?? null;
    setNotice({ title, ...(message !== undefined ? { message } : {}) });
    setVisible(true);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    const onDismiss = onDismissRef.current;
    onDismissRef.current = null;
    onDismiss?.();
  }, []);

  return {
    showError,
    errorSheet: <LegacyErrorSheet visible={visible} notice={notice} onClose={dismiss} />,
  };
}

function LegacyErrorSheet({
  visible,
  notice,
  onClose,
}: {
  readonly visible: boolean;
  readonly notice: LegacyNotice | null;
  readonly onClose: () => void;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <Sheet
      visible={visible && notice !== null}
      onClose={onClose}
      accessibilityLabel={notice?.title ?? 'Erreur'}
      closeAccessibilityLabel="Fermer"
    >
      {notice !== null ? (
        <>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
          >
            {notice.title}
          </Text>
          {notice.message !== undefined ? (
            <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 14 }]}>
              {notice.message}
            </Text>
          ) : null}
          <View style={{ marginBottom: 8, marginTop: notice.message === undefined ? 6 : 0 }}>
            <Button title="OK" onPress={onClose} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

/* ──────────────────────────────────────────────────────────────────────────────── */

type AnyHandle = { showError: (title: string, message?: string) => void; errorSheet: ReactNode };

function HookHost({
  useHook,
  onReady,
}: {
  readonly useHook: () => AnyHandle;
  readonly onReady: (handle: AnyHandle) => void;
}) {
  const handle = useHook();
  onReady(handle);
  return <ThemeProvider>{handle.errorSheet}</ThemeProvider>;
}

async function renderShown(
  useHook: () => AnyHandle,
  title: string,
  message?: string,
): Promise<ReactTestRenderer> {
  let handle: AnyHandle | null = null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<HookHost useHook={useHook} onReady={(value) => (handle = value)} />);
  });
  await act(async () => {
    handle!.showError(title, message);
  });
  return renderer;
}

/**
 * Arbre NORMALISÉ pour l'égalité : JSON round-trip — les props-fonctions (onPress/onClose,
 * closures NEUVES par instance, par nature) sont retirées ; chaque balise hôte, chaque prop
 * sérialisable et chaque valeur de style restent comparées à l'unité près.
 */
function normalizedTree(renderer: ReactTestRenderer): unknown {
  return JSON.parse(JSON.stringify(renderer.toJSON())) as unknown;
}

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
  isReduceMotionEnabled.mockResolvedValue(false);
});

describe('ErrorSheet — promotion @bob/ui (iso-rendu)', () => {
  it('le module local est un PUR réexport : même référence de fonction que @bob/ui', () => {
    expect(useErrorSheet).toBe(kitUseErrorSheet);
  });

  it('titre + message : arbre rendu STRICTEMENT identique à l’implémentation locale d’avant', async () => {
    const promoted = await renderShown(
      useErrorSheet,
      'Aperçu indisponible',
      'La preuve comptable reçue est incohérente.',
    );
    const legacy = await renderShown(
      useLegacyErrorSheet,
      'Aperçu indisponible',
      'La preuve comptable reçue est incohérente.',
    );

    const promotedTree = normalizedTree(promoted);
    const legacyTree = normalizedTree(legacy);
    // Témoin : les deux arbres existent et portent bien la feuille ouverte.
    expect(JSON.stringify(promotedTree)).toContain('Aperçu indisponible');
    expect(JSON.stringify(legacyTree)).toContain('Aperçu indisponible');
    expect(promotedTree).toEqual(legacyTree);
  });

  it('titre SEUL (chemin marginTop 6) : arbre identique aussi', async () => {
    const promoted = await renderShown(useErrorSheet, 'Oups');
    const legacy = await renderShown(useLegacyErrorSheet, 'Oups');
    const promotedTree = normalizedTree(promoted);
    expect(JSON.stringify(promotedTree)).toContain('Oups');
    expect(promotedTree).toEqual(normalizedTree(legacy));
  });
});
