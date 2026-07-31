/**
 * PRÉFÉRENCES TRI-ÉTAT — le test qui verrouille le fail-CLOSED au PREMIER rendu.
 *
 * Le défaut qu'il ferme est précis : un hook booléen initialisé à `false` répond « pas de
 * réduction » pendant la fenêtre où la valeur n'est pas encore revenue. Ce test-ci constate que
 * le premier rendu vaut `'unknown'`, pas `'inactive'` — c'est toute la différence entre
 * « on n'anime pas avant de savoir » et « on anime puis on coupe ».
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isReduceMotionEnabled, isScreenReaderEnabled, addEventListener, remove } = vi.hoisted(
  () => ({
    isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
    isScreenReaderEnabled: vi.fn<() => Promise<boolean>>(),
    addEventListener: vi.fn(),
    remove: vi.fn(),
  }),
);

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => isReduceMotionEnabled(),
    isScreenReaderEnabled: () => isScreenReaderEnabled(),
    addEventListener: (...args: unknown[]) => {
      addEventListener(...args);
      return { remove };
    },
  },
}));

const {
  useReduceMotionPreference,
  useScreenReaderPreference,
} = await import('./use-accessibility-preference');

function Probe({ hook, sink }: { hook: () => string; sink: (value: string) => void }): null {
  sink(hook());
  return null;
}

async function renderHook(hook: () => string): Promise<{ values: string[]; tree: ReactTestRenderer }> {
  const values: string[] = [];
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(Probe, { hook, sink: (v) => values.push(v) }));
  });
  return { values, tree: tree as ReactTestRenderer };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('préférences d’accessibilité — trois états, jamais deux', () => {
  it('vaut `unknown` au PREMIER rendu, avant toute résolution — fail-closed', async () => {
    let resolveRead: ((value: boolean) => void) | undefined;
    isReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { values } = await renderHook(useReduceMotionPreference);
    expect(values[0]).toBe('unknown');
    expect(values[0]).not.toBe('inactive');
    resolveRead?.(false);
  });

  it('passe à `inactive` quand la préférence revient à faux', async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    const { values } = await renderHook(useReduceMotionPreference);
    expect(values.at(-1)).toBe('inactive');
  });

  it('passe à `active` quand la préférence revient à vrai', async () => {
    isReduceMotionEnabled.mockResolvedValue(true);
    const { values } = await renderHook(useReduceMotionPreference);
    expect(values.at(-1)).toBe('active');
  });

  it('RESTE `unknown` si la lecture échoue — on ne décide pas à la place de l’utilisateur', async () => {
    isReduceMotionEnabled.mockRejectedValue(new Error('pont natif indisponible'));
    const { values } = await renderHook(useReduceMotionPreference);
    expect(values.at(-1)).toBe('unknown');
  });

  it('s’abonne au changement système et se désabonne au démontage', async () => {
    isScreenReaderEnabled.mockResolvedValue(false);
    const { tree } = await renderHook(useScreenReaderPreference);
    expect(addEventListener).toHaveBeenCalledWith('screenReaderChanged', expect.any(Function));
    await act(async () => {
      tree.unmount();
    });
    expect(remove).toHaveBeenCalled();
  });

  it('le lecteur d’écran a son propre hook — la fenêtre inconnue y vaut aussi « actif »', async () => {
    let resolveRead: ((value: boolean) => void) | undefined;
    isScreenReaderEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { values } = await renderHook(useScreenReaderPreference);
    expect(values[0]).toBe('unknown');
    resolveRead?.(false);
  });
});
