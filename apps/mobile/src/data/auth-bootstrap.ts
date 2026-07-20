export class AuthBootstrapTimeoutError extends Error {
  readonly code = 'AUTH_BOOTSTRAP_TIMEOUT' as const;

  constructor(readonly timeoutMs: number) {
    super(`Auth bootstrap exceeded ${timeoutMs} ms.`);
    this.name = 'AuthBootstrapTimeoutError';
  }
}

/**
 * Borne l'initialisation de session sans laisser la promesse tardive produire un rejet non géré.
 * La source Supabase n'est pas abortable : on fence donc son résultat après le premier règlement.
 */
export function loadAuthBootstrapWithTimeout<T>(
  load: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('AUTH_BOOTSTRAP_TIMEOUT_INVALID'));
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
      () => finish(() => reject(new AuthBootstrapTimeoutError(timeoutMs))),
      timeoutMs,
    );

    try {
      load().then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error: unknown) {
      finish(() => reject(error));
    }
  });
}
