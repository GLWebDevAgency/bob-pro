export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
}

/** Implémentation no-op (V1). Brancher @sentry/node derrière ce port via SENTRY_DSN. */
export class NoopErrorReporter implements ErrorReporter {
  captureException(): void {
    // intentionnellement vide — voir SENTRY_DSN pour activer un vrai reporter
  }
}
