export class AuthRequestTimeoutError extends Error {
  readonly code = 'AUTH_REQUEST_TIMEOUT' as const;

  constructor(readonly timeoutMs: number) {
    super(`Auth request exceeded ${timeoutMs} ms.`);
    this.name = 'AuthRequestTimeoutError';
  }
}

/**
 * Supabase Auth n'expose pas de signal d'annulation pour ces méthodes. On borne donc l'UI et on
 * absorbe le règlement tardif, afin qu'un réseau captif ne laisse jamais un bouton bloqué.
 */
export function runAuthRequestWithTimeout<T>(
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('AUTH_REQUEST_TIMEOUT_INVALID'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new AuthRequestTimeoutError(timeoutMs))),
      timeoutMs,
    );

    try {
      request().then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error: unknown) {
      finish(() => reject(error));
    }
  });
}
