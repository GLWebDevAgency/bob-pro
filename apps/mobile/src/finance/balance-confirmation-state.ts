/**
 * SOLDE PÉRIMÉ → CONFIRMATION EN PREMIER PLAN (incident fondateur, nuit du 01→02/08/2026).
 *
 * BANK_BALANCE_FRESHNESS_POLICY_V1 : un solde confirmé manuellement expire à 24 h. L'API
 * répond alors 503 {kind:'unavailable', service:'bank-balance-stale'} sur /bank-balance ET
 * sur /cashflow. Vécu en vrai : l'écran Argent présentait une ERREUR GÉNÉRIQUE plein écran
 * (les six queries cashflow, non reconnues comme « entrée bancaire attendue », rendaient
 * l'erreur BLOQUANTE) et la carte « confirme ton solde » n'existait même plus.
 *
 * Ce module PUR discrimine STRICTEMENT les causes (séparé du rendu, patron du repo) :
 *  · le refus de QUALIFICATION du solde (périmé `stale` ou jamais confirmé `unconfirmed`)
 *    est un état ATTENDU du produit — l'écran doit présenter LA CONFIRMATION comme état
 *    principal, jamais une panne ;
 *  · un VRAI incident (toute erreur qui n'est PAS une entrée bancaire attendue —
 *    `isExpectedMissingBankingInput`) garde l'état d'erreur d'avant, inchangé.
 */
import {
  isBankBalanceQualificationError,
  isExpectedMissingBankingInput,
} from '../data/cashflow-banking-state';

export interface QueryFailureLike {
  readonly failed: boolean;
  readonly error: unknown;
}

/** Pourquoi le solde attend une confirmation — pilote la pédagogie du point de décision. */
export type BalanceConfirmationReason = 'stale' | 'unconfirmed';

export interface BalanceConfirmationState {
  /** Le GET solde lui-même est un refus de qualification (périmé ou jamais confirmé). */
  readonly balanceNeedsConfirmation: boolean;
  /** Pédagogie : périmé (24 h dépassées) vs jamais confirmé. Null si pas de refus. */
  readonly reason: BalanceConfirmationReason | null;
  /**
   * TOUTES les queries cashflow en échec s'expliquent par l'entrée bancaire attendue
   * (aucun VRAI incident caché derrière la confirmation). Vrai aussi quand rien n'échoue.
   */
  readonly cashflowOnlyAwaitsBalance: boolean;
  /**
   * La confirmation est LA SEULE cause d'indisponibilité → état PRINCIPAL de l'écran :
   * héros remplacé par la confirmation actionnable, AUCUN bandeau d'erreur générique.
   */
  readonly confirmationIsPrimary: boolean;
}

function confirmationReason(error: unknown): BalanceConfirmationReason {
  const candidate = error !== null && typeof error === 'object' ? (error as { kind?: unknown }) : null;
  return candidate?.kind === 'not_found' ? 'unconfirmed' : 'stale';
}

export function deriveBalanceConfirmationState(input: {
  readonly balance: QueryFailureLike;
  readonly cashflow: readonly QueryFailureLike[];
}): BalanceConfirmationState {
  const balanceNeedsConfirmation =
    input.balance.failed && isBankBalanceQualificationError(input.balance.error);
  const cashflowOnlyAwaitsBalance = input.cashflow.every(
    (query) => !query.failed || isExpectedMissingBankingInput(query.error),
  );
  return {
    balanceNeedsConfirmation,
    reason: balanceNeedsConfirmation ? confirmationReason(input.balance.error) : null,
    cashflowOnlyAwaitsBalance,
    confirmationIsPrimary: balanceNeedsConfirmation && cashflowOnlyAwaitsBalance,
  };
}
