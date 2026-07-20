/**
 * Traduction AppError → message utilisateur (module PUR, zéro import React Native — testable
 * seul). Doctrine : le mobile ne reformule JAMAIS un refus porteur d'un message fabriqué par
 * le serveur/@bob/core (pourquoi, jusqu'à quand, quoi faire) — il l'affiche tel quel ; le
 * fallback générique est réservé aux erreurs réellement muettes (réseau, inconnu).
 */
export function appErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e) {
    const err = e as {
      kind: string;
      reason?: string;
      error?: { code?: string; message?: string };
      issues?: unknown;
    };
    if (err.kind === 'forbidden') return err.reason ?? 'Action non autorisée pour ton offre.';
    if (err.kind === 'dependency')
      return 'Service indisponible pour le moment. Réessaie ou saisis les infos à la main.';
    if (err.kind === 'not_found') return 'Introuvable.';
    // A3 — gel de rétractation (RETRACTATION_PERIOD_ACTIVE) et autres refus du domaine porteurs
    // d'un message : on affiche le message HONNÊTE fabriqué par @bob/core (pourquoi, jusqu'à
    // quand, ce qui reste possible) au lieu d'un « Action impossible » muet. Source unique — le
    // mobile ne reformule jamais un refus légal.
    if (err.kind === 'domain' && typeof err.error?.message === 'string' && err.error.message)
      return err.error.message;
    // Refus de VALIDATION (422) : mêmes droits que les refus domain — la première issue porte
    // le message actionnable (ex. « Email du client manquant — complète sa fiche… », endpoint
    // embargo-scheduled-payment). Bug terrain 20/07 : ce kind tombait sur le fallback muet.
    if (err.kind === 'validation' && Array.isArray(err.issues) && err.issues.length > 0) {
      const first = err.issues[0] as { message?: unknown } | null;
      if (first && typeof first.message === 'string' && first.message) return first.message;
    }
  }
  return 'Action impossible. Réessaie.';
}
