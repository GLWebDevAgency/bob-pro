import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBeforeSignOutCleanupsForTests,
  registerBeforeSignOutCleanup,
  runBeforeSignOutCleanups,
} from './session-cleanup';

afterEach(() => {
  clearBeforeSignOutCleanupsForTests();
  vi.useRealTimers();
});

describe('nettoyages pré-déconnexion', () => {
  it('exécute les adapters en parallèle et absorbe leurs erreurs', async () => {
    const success = vi.fn(async () => undefined);
    const failure = vi.fn(async () => {
      throw new Error('réseau indisponible');
    });
    registerBeforeSignOutCleanup(success);
    registerBeforeSignOutCleanup(failure);

    await expect(runBeforeSignOutCleanups()).resolves.toEqual({
      completed: 1,
      failed: 1,
      timedOut: false,
    });
    expect(success).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
  });

  it('désinscrit un adapter démonté', async () => {
    const cleanup = vi.fn(async () => undefined);
    const unregister = registerBeforeSignOutCleanup(cleanup);
    unregister();

    await expect(runBeforeSignOutCleanups()).resolves.toEqual({
      completed: 0,
      failed: 0,
      timedOut: false,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('borne une révocation lente sans rejection tardive non gérée', async () => {
    vi.useFakeTimers();
    registerBeforeSignOutCleanup(() => new Promise<void>(() => undefined));

    const report = runBeforeSignOutCleanups(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(report).resolves.toEqual({ completed: 0, failed: 0, timedOut: true });
  });
});
