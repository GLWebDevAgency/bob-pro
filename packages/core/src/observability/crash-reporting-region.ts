/**
 * SOUVERAINETÉ DE LA TÉLÉMÉTRIE — région de la destination de crash reporting.
 *
 * Sentry SaaS crée les organisations en région **US par défaut**. Un DSN collé sans vigilance
 * enverrait donc, en silence et sans aucune erreur visible, les rapports de plantage d'une
 * application financière française hors de l'Union — exactement le contraire de la posture
 * actée (§B4, RGPD). Seule la région européenne est admise.
 *
 * Règle unique, partagée par les deux frontières qui l'appliquent différemment :
 * - côté serveur, un DSN non conforme REFUSE LE DÉMARRAGE (fail-closed au boot) ;
 * - côté mobile, il empêche l'initialisation du SDK — jamais un plantage de l'application,
 *   qui transformerait une garde de confidentialité en panne pour l'artisan.
 */

/** Hôte d'ingestion de la région européenne de Sentry (`o<org>.ingest.de.sentry.io`). */
export const SENTRY_EU_INGEST_SUFFIX = '.ingest.de.sentry.io';

/**
 * Renvoie la raison pour laquelle un DSN est refusé, ou `null` s'il est conforme.
 * Retourner la raison plutôt qu'un booléen permet au serveur de refuser le boot avec un
 * message actionnable, sans dupliquer la formulation à chaque frontière.
 */
export function sentryDsnRejectionReason(dsn: string): string | null {
  if (dsn.includes('[') || dsn.includes(']')) return 'contient un placeholder';
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return "n'est pas une URL de DSN valide";
  }
  if (url.protocol !== 'https:') return 'doit utiliser HTTPS';
  if (!url.username) return 'doit porter la clé publique du projet (https://<clé>@<hôte>/<id>)';
  if (!url.hostname.endsWith(SENTRY_EU_INGEST_SUFFIX)) {
    return (
      `doit cibler la région UE de Sentry (hôte en *${SENTRY_EU_INGEST_SUFFIX}) : `
      + `« ${url.hostname} » est refusé. Recréer l'organisation avec Data Region = Europe`
    );
  }
  return null;
}
