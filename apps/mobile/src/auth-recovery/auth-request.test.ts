import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequestTimeoutError, runAuthRequestWithTimeout } from './auth-request';

describe('runAuthRequestWithTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('retourne la réponse avant la borne', async () => {
    await expect(runAuthRequestWithTimeout(async () => 'ok', 100)).resolves.toBe('ok');
  });

  it('fence une réponse tardive sans rejet non géré', async () => {
    vi.useFakeTimers();
    let resolveLate: ((value: string) => void) | undefined;
    const result = runAuthRequestWithTimeout(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
      12_000,
    );
    const expectation = expect(result).rejects.toMatchObject({
      name: 'AuthRequestTimeoutError',
      code: 'AUTH_REQUEST_TIMEOUT',
      timeoutMs: 12_000,
    } satisfies Partial<AuthRequestTimeoutError>);
    await vi.advanceTimersByTimeAsync(12_000);
    await expectation;
    resolveLate?.('late');
    await Promise.resolve();
  });
});
