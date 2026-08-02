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
  hasUnqualifiedCashflowBankingSource,
  isBankBalanceQualificationError,
  isCashflowBankingInputMissing,
  isExpectedMissingBankingInput,
} from '../data/cashflow-banking-state';

export interface QueryFailureLike {
  readonly failed: boolean;
  readonly error: unknown;
  /** Premier fetch encore indéterminé : `bankingSource:none` ne devient pas un incident avant lui. */
  readonly loading?: boolean;
  /** Snapshot sain éventuel. Seul `bankingSource:none` est inspecté, jamais un montant. */
  readonly data?: unknown;
}

/** Pourquoi le solde attend une confirmation — pilote la pédagogie du point de décision. */
export type BalanceConfirmationReason = 'stale' | 'unconfirmed';

export interface BalanceConfirmationState {
  /** Le GET solde lui-même est un refus de qualification (périmé ou jamais confirmé). */
  readonly balanceNeedsConfirmation: boolean;
  /** Le GET solde a échoué pour une cause autre que stale/not_found. */
  readonly balanceHasUnexpectedFailure: boolean;
  /** Pédagogie : périmé (24 h dépassées) vs jamais confirmé. Null si pas de refus. */
  readonly reason: BalanceConfirmationReason | null;
  /**
   * TOUTES les queries cashflow en échec s'expliquent par l'entrée bancaire attendue
   * (aucun VRAI incident caché derrière la confirmation). Vrai aussi quand rien n'échoue.
   */
  readonly cashflowOnlyAwaitsBalance: boolean;
  /** Une erreur cashflow ne peut être masquée que si le GET solde confirme la même absence. */
  readonly cashflowHasUnexpectedFailure: boolean;
  /** Le cashflow a invalidé la qualification du solde (erreur bancaire ou sentinel `none`). */
  readonly cashflowInvalidatesBalance: boolean;
  /**
   * La confirmation est LA SEULE cause d'indisponibilité → état PRINCIPAL de l'écran :
   * héros remplacé par la confirmation actionnable, AUCUN bandeau d'erreur générique.
   */
  readonly confirmationIsPrimary: boolean;
}

function confirmationReason(error: unknown): BalanceConfirmationReason {
  const candidate =
    error !== null && typeof error === 'object' ? (error as { kind?: unknown }) : null;
  return candidate?.kind === 'not_found' ? 'unconfirmed' : 'stale';
}

export function deriveBalanceConfirmationState(input: {
  readonly balance: QueryFailureLike;
  readonly cashflow: readonly QueryFailureLike[];
}): BalanceConfirmationState {
  const balanceQueryNeedsConfirmation =
    input.balance.failed && isBankBalanceQualificationError(input.balance.error);
  const balanceHasUnexpectedFailure = input.balance.failed && !balanceQueryNeedsConfirmation;
  const cashflowQualificationFailure = input.cashflow.find(
    (query) => query.failed && isBankBalanceQualificationError(query.error),
  );
  // Le serveur cashflow relit la même observation qualifiée. Son signal stale exact peut donc
  // devancer le refetch GET solde : il invalide immédiatement le cache bancaire encore nominal.
  const balanceNeedsConfirmation =
    !balanceHasUnexpectedFailure &&
    (balanceQueryNeedsConfirmation || cashflowQualificationFailure !== undefined);
  const cashflowInvalidatesBalance = input.cashflow.some(
    (query) =>
      (query.failed && isExpectedMissingBankingInput(query.error)) ||
      (!query.failed && hasUnqualifiedCashflowBankingSource(query.data)),
  );
  const cashflowHasUnexpectedFailure = input.cashflow.some(
    (query) => {
      if (query.failed) {
        // `/cashflow` peut répondre « aucune source » avant que le GET solde ait fini. Ce n'est
        // ni une confirmation ni un incident tant que ce second verdict reste indéterminé.
        if (input.balance.loading === true && isCashflowBankingInputMissing(query.error)) {
          return false;
        }
        return !balanceNeedsConfirmation || !isExpectedMissingBankingInput(query.error);
      }
      // `none` avec un GET solde stale/404 = confirmation attendue. Avec un GET nominal, les
      // deux endpoints se contredisent : récupération fail-closed, jamais héros/KPI à zéro.
      return (
        hasUnqualifiedCashflowBankingSource(query.data) &&
        !balanceNeedsConfirmation &&
        input.balance.loading !== true
      );
    },
  );
  const cashflowOnlyAwaitsBalance = !cashflowHasUnexpectedFailure;
  return {
    balanceNeedsConfirmation,
    balanceHasUnexpectedFailure,
    reason: balanceNeedsConfirmation
      ? confirmationReason(
          balanceQueryNeedsConfirmation
            ? input.balance.error
            : cashflowQualificationFailure?.error,
        )
      : null,
    cashflowOnlyAwaitsBalance,
    cashflowHasUnexpectedFailure,
    cashflowInvalidatesBalance,
    confirmationIsPrimary: balanceNeedsConfirmation && !cashflowHasUnexpectedFailure,
  };
}
