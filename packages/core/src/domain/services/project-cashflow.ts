export type Scenario = 'optimiste' | 'realiste' | 'prudent';
export type Horizon = 7 | 30 | 60 | 90;

export interface CashflowProjection {
  available: number; // dispo previsionnel (centimes)
  payout: number; // "te verser" sans risque (centimes)
  risk: boolean; // true si la dispo passe sous zero
  /** TVA a provisionner (centimes) — deja deduite de `available` ; exposee pour le KPI
   *  du briefing (A3-C10) : le meme chiffre que celui qui ampute la dispo, jamais un autre. */
  vatDue: number;
}

const RECEIVABLE_FACTOR: Record<Scenario, number> = { optimiste: 1, realiste: 0.9, prudent: 0.8 };

export function projectCashflow(
  input: { bankBalance: number; receivables: number; charges: number; vatDue: number },
  scenario: Scenario,
  horizon: Horizon,
): CashflowProjection {
  const horizonFactor = Math.min(1, horizon / 90); // plus l'horizon est long, plus d'encours rentrent
  const probableReceipts = Math.round(input.receivables * RECEIVABLE_FACTOR[scenario] * horizonFactor);
  const available = input.bankBalance + probableReceipts - input.charges - input.vatDue;
  // "Te verser" = ce qu'on peut sortir en gardant une reserve TVA + marge de securite.
  const safetyReserve = Math.round(input.vatDue * 0.5);
  const payout = Math.max(0, available - safetyReserve);
  return { available, payout, risk: available < 0, vatDue: input.vatDue };
}
