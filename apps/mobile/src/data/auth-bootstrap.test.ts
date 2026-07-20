import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBootstrapTimeoutError, loadAuthBootstrapWithTimeout } from './auth-bootstrap';

describe('loadAuthBootstrapWithTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('retourne la session quand la source répond avant la borne', async () => {
    await expect(loadAuthBootstrapWithTimeout(async () => 'session', 100)).resolves.toBe('session');
  });

  it('échoue de façon typée à la borne et ignore une résolution tardive', async () => {
    vi.useFakeTimers();
    let resolveLate: ((value: string) => void) | undefined;
    const result = loadAuthBootstrapWithTimeout(
      () => new Promise<string>((resolve) => {
        resolveLate = resolve;
      }),
      8_000,
    );

    const expectation = expect(result).rejects.toMatchObject({
      name: 'AuthBootstrapTimeoutError',
      code: 'AUTH_BOOTSTRAP_TIMEOUT',
      timeoutMs: 8_000,
    } satisfies Partial<AuthBootstrapTimeoutError>);
    await vi.advanceTimersByTimeAsync(8_000);
    await expectation;
    resolveLate?.('too-late');
    await Promise.resolve();
  });

  it('propage un rejet source et refuse une borne invalide', async () => {
    const sourceError = new Error('storage unavailable');
    await expect(loadAuthBootstrapWithTimeout(async () => Promise.reject(sourceError), 100)).rejects.toBe(
      sourceError,
    );
    await expect(loadAuthBootstrapWithTimeout(async () => null, 0)).rejects.toThrow(
      'AUTH_BOOTSTRAP_TIMEOUT_INVALID',
    );
  });
});
