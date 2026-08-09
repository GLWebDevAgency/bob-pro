import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { Button } from './button';
import { BUTTON_MIN_HEIGHT } from './button.logic';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

function renderButton(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <Button
          title="Écrire dans l’Assistant"
          accessibilityHint="Ouvrir le mode texte sans relancer le microphone."
          onPress={() => undefined}
        />
      </ThemeProvider>,
    );
  });
  return renderer;
}

describe('Button — hint lecteur d’écran', () => {
  it('transmet label, hint, rôle et conserve la cible tactile 44 points', () => {
    const renderer = renderButton();
    const pressable = renderer.root.findByType('Pressable' as never);
    expect(pressable.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Écrire dans l’Assistant',
      accessibilityHint: 'Ouvrir le mode texte sans relancer le microphone.',
    });
    const styles = pressable.props.style({ pressed: false }) as readonly Record<string, unknown>[];
    expect(styles[0]).toMatchObject({
      minHeight: BUTTON_MIN_HEIGHT,
      minWidth: BUTTON_MIN_HEIGHT,
    });
    expect(BUTTON_MIN_HEIGHT).toBeGreaterThanOrEqual(44);
  });
});
