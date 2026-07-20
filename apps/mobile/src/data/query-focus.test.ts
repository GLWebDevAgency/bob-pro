import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusManager } from '@tanstack/react-query';
import type { AppStateStatus } from 'react-native';
import {
  connectFocusManagerToAppState,
  isForegroundStatus,
  type AppStateLike,
} from './query-focus';

/** Fake AppState : mémorise les listeners et permet d'émettre des transitions. */
function makeFakeAppState() {
  const listeners = new Set<(status: AppStateStatus) => void>();
  const appState: AppStateLike = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const emit = (status: AppStateStatus): void => {
    for (const listener of listeners) listener(status);
  };
  return { appState, emit, listenerCount: () => listeners.size };
}

describe('isForegroundStatus', () => {
  it("seul 'active' est un premier plan — 'inactive' (transition iOS) n'en est pas un", () => {
    expect(isForegroundStatus('active')).toBe(true);
    expect(isForegroundStatus('inactive')).toBe(false);
    expect(isForegroundStatus('background')).toBe(false);
    expect(isForegroundStatus('unknown')).toBe(false);
    expect(isForegroundStatus('extension')).toBe(false);
  });
});

describe('connectFocusManagerToAppState', () => {
  afterEach(() => {
    // Réarme le mode automatique du focusManager global (jamais d'état résiduel entre tests).
    focusManager.setFocused(undefined);
  });

  it('traduit chaque transition AppState en setFocused (true uniquement au premier plan)', () => {
    const { appState, emit } = makeFakeAppState();
    const setFocused = vi.fn();
    connectFocusManagerToAppState(appState, { setFocused });

    emit('background');
    emit('active');
    emit('inactive');

    expect(setFocused.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('le débranchement retire la souscription — plus aucun setFocused ensuite', () => {
    const { appState, emit, listenerCount } = makeFakeAppState();
    const setFocused = vi.fn();
    const disconnect = connectFocusManagerToAppState(appState, { setFocused });

    emit('active');
    disconnect();
    emit('background');

    expect(listenerCount()).toBe(0);
    expect(setFocused.mock.calls).toEqual([[true]]);
  });

  it('pilote par défaut le focusManager RÉEL de React Query (celui du QueryClient)', () => {
    const { appState, emit } = makeFakeAppState();
    const disconnect = connectFocusManagerToAppState(appState);

    emit('background');
    expect(focusManager.isFocused()).toBe(false);
    emit('active');
    expect(focusManager.isFocused()).toBe(true);

    disconnect();
  });
});
