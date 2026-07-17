export type Scenario = 'optimiste' | 'realiste' | 'prudent';
export type Horizon = 7 | 30 | 60 | 90;

export interface CashflowProjection {
  available: number; // dispo previsionnel (centimes)
  payout: number; // trésorerie mobilisable sans risque (centimes) — PAS une rémunération (dépend du statut/régime, non modélisé ici)
  risk: boolean; // true si la dispo passe sous zero
  /** TVA a provisionner (centimes) — deja deduite de `available` ; exposee pour le KPI
   *  du briefing (A3-C10) : le meme chiffre que celui qui ampute la dispo, jamais un autre. */
  vatDue: number;
  /** Hypothèses auditables : l'UI peut distinguer une projection datée d'un agrégat legacy. */
  basis: CashflowProjectionBasis;
}

export interface DatedCashflowBasisInput {
  readonly kind: 'dated_documents';
  readonly asOf: string;
  readonly horizonEnd: string;
  readonly receivablesIncludedCents: number;
  readonly receivablesAfterHorizonCents: number;
  readonly receivablesUndatedCents: number;
  readonly chargesIncludedCents: number;
  readonly chargesAfterHorizonCents: number;
  readonly chargesUndatedIncludedCents: number;
}

export type CashflowProjectionBasis =
  | {
      readonly modelVersion: 'cashflow-projection/2';
      readonly kind: 'dated_documents';
      readonly scenario: Scenario;
      readonly horizonDays: Horizon;
      readonly receivableCollectionRatePct: 100 | 90 | 80;
      readonly asOf: string;
      readonly horizonEnd: string;
      readonly receivablesIncludedCents: number;
      readonly receivablesAfterHorizonCents: number;
      readonly receivablesUndatedCents: number;
      readonly chargesIncludedCents: number;
      readonly chargesAfterHorizonCents: number;
      readonly chargesUndatedIncludedCents: number;
    }
  | {
      readonly modelVersion: 'cashflow-projection/2';
      readonly kind: 'aggregate_legacy';
      readonly scenario: Scenario;
      readonly horizonDays: Horizon;
      readonly receivableCollectionRatePct: 100 | 90 | 80;
    };

const RECEIVABLE_RATE_PCT: Record<Scenario, 100 | 90 | 80> = {
  optimiste: 100,
  realiste: 90,
  prudent: 80,
};

export function projectCashflow(
  input: {
    bankBalance: number;
    receivables: number;
    charges: number;
    vatDue: number;
    datedBasis?: DatedCashflowBasisInput;
  },
  scenario: Scenario,
  horizon: Horizon,
): CashflowProjection {
  const receiptRatePct = RECEIVABLE_RATE_PCT[scenario];
  // En production, les pièces ont déjà été bornées par leur échéance : appliquer une
  // seconde règle horizon/90 inventerait une dilution supplémentaire. Le facteur historique ne
  // subsiste que pour les adapters de test qui ne fournissent aucun échéancier.
  const horizonFactor = input.datedBasis ? 1 : Math.min(1, horizon / 90);
  const probableReceipts = Math.round(input.receivables * (receiptRatePct / 100) * horizonFactor);
  const available = input.bankBalance + probableReceipts - input.charges - input.vatDue;
  // "Payout" = trésorerie mobilisable en gardant une reserve TVA + marge de securite —
  // PAS une rémunération distribuable (forme juridique/regime fiscal hors scope ici).
  const safetyReserve = Math.round(input.vatDue * 0.5);
  const payout = Math.max(0, available - safetyReserve);
  const basis: CashflowProjectionBasis = input.datedBasis
    ? {
        modelVersion: 'cashflow-projection/2',
        ...input.datedBasis,
        scenario,
        horizonDays: horizon,
        receivableCollectionRatePct: receiptRatePct,
      }
    : {
        modelVersion: 'cashflow-projection/2',
        kind: 'aggregate_legacy',
        scenario,
        horizonDays: horizon,
        receivableCollectionRatePct: receiptRatePct,
      };
  return { available, payout, risk: available < 0, vatDue: input.vatDue, basis };
}
