import type { Provider } from '@nestjs/common';
import type { AnalyticsPort, TrackedEvent } from '@bob/core';
import { NOOP_ANALYTICS } from '@bob/core';
import { AppLogger } from './logger';

/**
 * ANALYTICS PRODUIT SERVEUR (pilier 2) — l'adapter du port @bob/core AnalyticsPort, sur le
 * gabarit exact d'error-reporter.ts : Symbol + Noop + Http + factory env.
 *
 * Doctrine (SPEC_PILIER2 décision 11 + RGPD) :
 * · OPT-OUT STRUCTUREL : sans PRODUCT_ANALYTICS_ENDPOINT, c'est le Noop — l'analytics est
 *   une option de l'exploitant, jamais une condition de fonctionnement (contrairement à
 *   l'error reporter, AUCUNE obligation hors démo : on peut opérer sans tracking) ;
 * · fire-and-forget : un événement perdu est perdu — l'analytics ne fait JAMAIS échouer ni
 *   ralentir une action utilisateur (timeout court, erreurs avalées en warn) ;
 * · ZÉRO PII : le schéma TrackedEvent (@bob/core) ne porte que tenantId opaque + noms
 *   d'événements typés — aucun email, nom, contenu ; le endpoint reçoit ce schéma tel quel.
 */

export const ANALYTICS = Symbol('ANALYTICS');

export class HttpAnalytics implements AnalyticsPort {
  constructor(
    private readonly endpoint: string,
    private readonly logger: AppLogger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  track(event: TrackedEvent): void {
    void this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'bob-pro-api', ...event }),
      signal: AbortSignal.timeout(3_000),
    })
      .then((response) => {
        if (!response.ok) this.logger.warn(`Analytics HTTP ${response.status}.`, 'Analytics');
      })
      .catch(() => this.logger.warn('Analytics indisponible.', 'Analytics'));
  }
}

export function buildAnalytics(logger: AppLogger): AnalyticsPort {
  const endpoint = process.env.PRODUCT_ANALYTICS_ENDPOINT;
  if (!endpoint) return NOOP_ANALYTICS; // opt-out par défaut — jamais une condition d'exploitation
  return new HttpAnalytics(endpoint, logger);
}

export const analyticsProvider: Provider = {
  provide: ANALYTICS,
  inject: [AppLogger],
  useFactory: buildAnalytics,
};
