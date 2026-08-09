import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { consumeAssistantTextRecoveryFocus } from '../assistant/text-recovery-focus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@bob/ui', () => ({
  Button: (props: Record<string, unknown>) => createElement('Button', props),
}));

import { GlobalBobTextRecoveryAction } from './GlobalBobTextRecoveryAction';

describe('GlobalBobTextRecoveryAction — rendu et activation réels', () => {
  it('rend une action unique, accessible, puis navigue et arme le focus texte', () => {
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
    const routes: string[] = [];
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(GlobalBobTextRecoveryAction, {
          visible: true,
          personality: 'pro',
          navigate: (route: string) => routes.push(route),
        }),
      );
    });
    const buttons = renderer.root.findAllByType('Button' as never);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props).toMatchObject({
      title: 'Écrire dans l’Assistant',
      accessibilityHint: 'Ouvrir l’Assistant en mode texte, sans relancer le microphone.',
    });
    act(() => buttons[0]!.props.onPress());
    expect(routes).toEqual(['/(tabs)/assistant']);
    expect(consumeAssistantTextRecoveryFocus()).toBe(true);
  });

  it('ne rend rien hors issue terminale', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(GlobalBobTextRecoveryAction, {
          visible: false,
          personality: 'pote',
          navigate: vi.fn(),
        }),
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
