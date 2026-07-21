import { type DateOnly, type Instant } from '../../shared-kernel/time';

export type CashMovementDirection = 'in' | 'out';

/** Origine métier du mouvement — sert aussi à dédupliquer sans supposer des identifiants globaux. */
export type CashMovementSource = 'invoice_payment' | 'expense_settlement';

/**
 * Horodatage à la précision RÉELLEMENT disponible en base, jamais complétée par une heure inventée :
 * - `instant` : `Payment.receivedAt` (DateTime) ;
 * - `date` : `Expense.paymentEvidence.paidOn` (DATE seule, sans heure).
 *
 * Le use case applique une règle de bordure différente selon la précision (cf. derive-cash-position).
 */
export type CashMovementOccurrence =
  | { readonly precision: 'instant'; readonly value: Instant }
  | { readonly precision: 'date'; readonly value: DateOnly };

/**
 * Projection minimaliste d'un mouvement d'argent. Volontairement PAS un agrégat : le calcul de
 * position n'a besoin que d'un montant, d'un sens et d'une date, ce qui le rend testable sans ORM.
 */
export interface CashMovement {
  readonly id: string;
  readonly companyId: string;
  readonly source: CashMovementSource;
  readonly direction: CashMovementDirection;
  /** Montant ABSOLU en centimes (> 0) ; le sens est porté par `direction`, jamais par le signe. */
  readonly amountCents: number;
  readonly occurredAt: CashMovementOccurrence;
}

/** Port de lecture. Chaque méthode doit appliquer le `companyId` dans la requête SQL/RLS. */
export interface CashMovementProjectionPort {
  /**
   * Mouvements du tenant susceptibles d'être postérieurs à l'observation bancaire.
   *
   * `observedAt` est une BORNE D'OPTIMISATION pour le SQL, pas la règle : l'adapter ne doit jamais
   * filtrer plus strictement que le use case (pour les dates seules, descendre au jour Europe/Paris
   * de `observedAt`), sous peine de faire disparaître un mouvement légitime. Le filtrage qui fait
   * foi est réappliqué en mémoire par `deriveCashPosition`.
   */
  listSinceObservation(input: {
    companyId: string;
    observedAt: Instant;
  }): Promise<readonly CashMovement[]>;
}
