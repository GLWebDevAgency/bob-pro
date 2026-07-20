/**
 * Embargo L221-10 — logique PURE de l'écran « encaisser » (DocumentActions), testée sans RN.
 * Quand la génération de facture est refusée pendant la fenêtre légale (contrat hors
 * établissement B2C), le refus serveur porte tout le nécessaire : message honnête, dates,
 * affordance d'override (`overridable`) et risque concret (`overrideRisk`). Ce module traduit
 * l'erreur en invite structurée : DÉFAUT = encaissement programmé à J+7 ; OVERRIDE = feuille
 * de confirmation dédiée — jamais un contournement implicite.
 */
import { formatDateOnlyFr } from '@bob/core';

export interface EmbargoPrompt {
  /** Pièce demandée au moment du refus — rejouée telle quelle si l'artisan force. */
  readonly mode: 'deposit' | 'final';
  /** Message honnête du domaine (pourquoi, jusqu'à quand) — jamais reformulé. */
  readonly message: string;
  /** Premier jour légal (AAAA-MM-JJ) — pilote la programmation J+7. */
  readonly availableFrom: string;
  /** Premier jour légal au format FR (jj/mm/aaaa) — affichage boutons/hints. */
  readonly availableFromFr: string;
  /** Risque CONCRET reformulé par le domaine (nullité L242-1) — feuille d'override. */
  readonly overrideRisk: string | null;
  /** L'override responsabilisé est proposé UNIQUEMENT si le serveur l'affiche. */
  readonly overridable: boolean;
}

/**
 * Traduit un échec de génération en invite embargo — null pour toute autre erreur (le chemin
 * d'alerte générique reste inchangé). Fail-closed : une date absente/difforme = pas d'invite.
 */
export function embargoPromptOf(error: unknown, mode: 'deposit' | 'final'): EmbargoPrompt | null {
  if (!error || typeof error !== 'object' || !('kind' in error)) return null;
  const candidate = error as {
    kind: string;
    error?: {
      code?: string;
      message?: string;
      availableFrom?: string;
      overridable?: boolean;
      overrideRisk?: string;
    };
  };
  if (candidate.kind !== 'domain' || candidate.error?.code !== 'OFF_PREMISES_PAYMENT_EMBARGO')
    return null;
  const availableFrom = candidate.error.availableFrom;
  if (typeof availableFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(availableFrom)) return null;
  return {
    mode,
    message: typeof candidate.error.message === 'string' ? candidate.error.message : '',
    availableFrom,
    availableFromFr: formatDateOnlyFr(availableFrom),
    overrideRisk:
      typeof candidate.error.overrideRisk === 'string' ? candidate.error.overrideRisk : null,
    overridable: candidate.error.overridable === true,
  };
}

/**
 * Parité item 4 (canal de signature) : le conseil « envoie plutôt le lien » ne s'affiche que
 * pour un devis B2C NON urgent quand l'artisan choisit « sur place » — même prédicat au wizard
 * et sur l'écran devis (source unique, testée).
 */
export function shouldAdviseRemoteSignature(input: {
  readonly customerType: 'b2c' | 'b2b' | 'b2g' | null | undefined;
  readonly urgentRepairRequested: boolean;
}): boolean {
  return input.customerType === 'b2c' && !input.urgentRepairRequested;
}
