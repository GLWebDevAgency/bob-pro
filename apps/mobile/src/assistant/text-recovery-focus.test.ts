import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeAssistantTextRecoveryFocus,
  focusAssistantTextRecoveryIfRequested,
  requestAssistantTextRecoveryFocus,
  useAssistantVoiceErrorRecovery,
  useAssistantTextRecoveryFocus,
} from './text-recovery-focus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  consumeAssistantTextRecoveryFocus();
});

describe('sortie texte Bob → focus Assistant', () => {
  it('consomme exactement une fois et ne transporte aucun contenu', () => {
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
    requestAssistantTextRecoveryFocus();
    requestAssistantTextRecoveryFocus();
    expect(consumeAssistantTextRecoveryFocus()).toBe(true);
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
  });

  it('focalise le champ exactement une fois après la demande', () => {
    const focused: string[] = [];
    requestAssistantTextRecoveryFocus();
    expect(focusAssistantTextRecoveryIfRequested(() => {
      focused.push('input');
      return true;
    })).toBe(true);
    expect(focusAssistantTextRecoveryIfRequested(() => {
      focused.push('duplicate');
      return true;
    })).toBe(false);
    expect(focused).toEqual(['input']);
  });

  it('conserve l’intention pendant loading puis focalise une fois quand le champ est rendu', async () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const inputRef: { current: { focus(): void } | null } = { current: null };
    function Probe({ ready }: { readonly ready: boolean }) {
      useAssistantTextRecoveryFocus(ready, inputRef);
      return null;
    }

    requestAssistantTextRecoveryFocus();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(Probe, { ready: false }));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(focus).not.toHaveBeenCalled();

    inputRef.current = { focus };
    act(() => renderer.update(createElement(Probe, { ready: true })));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(consumeAssistantTextRecoveryFocus()).toBe(false);
    act(() => renderer.unmount());
  });

  it('annonce une erreur locale une fois puis focalise la saisie sans relancer la voix', async () => {
    vi.useFakeTimers();
    const announce = vi.fn();
    const focus = vi.fn();
    const inputRef = { current: { focus } };
    function Probe({ ready, message }: {
      readonly ready: boolean;
      readonly message: string | null;
    }) {
      useAssistantVoiceErrorRecovery({ ready, message, inputRef, announce });
      return null;
    }

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(Probe, { ready: false, message: 'Micro indisponible' })); });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(announce).not.toHaveBeenCalled();

    act(() => renderer.update(createElement(Probe, { ready: true, message: 'Micro indisponible' })));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(announce).toHaveBeenCalledWith('Micro indisponible');
    expect(focus).toHaveBeenCalledTimes(1);

    act(() => renderer.update(createElement(Probe, { ready: true, message: 'Micro indisponible' })));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
