import type { Provider } from '@nestjs/common';
import { isDemoMode } from '../config/env';
import { AppLogger } from './logger';

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

export class HttpErrorReporter implements ErrorReporter {
  constructor(
    private readonly endpoint: string,
    private readonly logger: AppLogger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    // Pas de message/stack/body : ils peuvent contenir PII ou un secret d'invitation.
    void this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'bob-pro-api', errorType, context }),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => {
      if (!response.ok) this.logger.warn(`Error reporter HTTP ${response.status}.`, 'ErrorReporter');
    }).catch(() => this.logger.warn('Error reporter indisponible.', 'ErrorReporter'));
  }
}

export function buildErrorReporter(logger: AppLogger): ErrorReporter {
  const endpoint = process.env.ERROR_REPORTER_WEBHOOK_URL;
  if (!endpoint) {
    if (isDemoMode()) return new NoopErrorReporter();
    throw new Error('ERROR_REPORTER_WEBHOOK_URL is required when DEMO_MODE=false.');
  }
  return new HttpErrorReporter(endpoint, logger);
}

export const errorReporterProvider: Provider = {
  provide: ERROR_REPORTER,
  inject: [AppLogger],
  useFactory: buildErrorReporter,
};
