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

/**
 * Disjoncteur : au-delà de N échecs CONSÉCUTIFS, la destination est considérée morte — un seul
 * log explicite puis silence, au lieu d'un WARN par exception (bruit qui noie le log utile).
 * Le log local de l'erreur d'origine (exception.filter) n'est jamais affecté.
 */
const REPORTER_DISABLE_AFTER_FAILURES = 5;

export class HttpErrorReporter implements ErrorReporter {
  private consecutiveFailures = 0;
  private disabled = false;

  constructor(
    private readonly endpoint: string,
    private readonly logger: AppLogger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    if (this.disabled) return;
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    // Pas de message/stack/body : ils peuvent contenir PII ou un secret d'invitation.
    void this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'bob-pro-api', errorType, context }),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => {
      if (response.ok) {
        this.consecutiveFailures = 0;
        return;
      }
      this.recordFailure(`HTTP ${response.status}`);
    }).catch(() => this.recordFailure('indisponible'));
  }

  private recordFailure(cause: string): void {
    if (this.disabled) return; // une réponse en vol après la coupure ne relogge pas
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < REPORTER_DISABLE_AFTER_FAILURES) {
      this.logger.warn(`Error reporter ${cause}.`, 'ErrorReporter');
      return;
    }
    this.disabled = true;
    this.logger.error(
      `Error reporter désactivé après ${REPORTER_DISABLE_AFTER_FAILURES} échecs consécutifs (${cause}). ` +
        'Vérifier ERROR_REPORTER_WEBHOOK_URL puis redémarrer pour réactiver.',
      undefined,
      'ErrorReporter',
    );
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
