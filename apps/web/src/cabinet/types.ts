import type { DateOnly, LegalForm, UrssafPeriodicity, VatRegime } from '@bob/core';

/** Régime d'imposition du bénéfice choisi par le cabinet pour ce dossier. */
export type IncomeTaxRegime = 'IR' | 'IS';

/**
 * Paramètres strictement nécessaires pour dériver l'échéancier. Ils sont conservés,
 * contrairement au FEC qui reste uniquement en mémoire le temps de l'analyse.
 */
export interface CabinetFiscalProfile {
  legalForm: LegalForm;
  vatRegime: VatRegime;
  incomeTaxRegime: IncomeTaxRegime;
  fiscalYearEnd: string | null;
  urssafPeriodicity: UrssafPeriodicity | null;
  dateCreation: DateOnly | null;
}

export interface CabinetDossierPeriod {
  from: DateOnly;
  to: DateOnly;
}

/** Synthèse financière persistable : aucune ligne ni écriture du FEC n'y figure. */
export interface CabinetFinancialSummary {
  /** Chiffre d'affaires issu des comptes 70x. */
  turnoverCents: number;
  resultCents: number;
  totalDebitCents: number;
  totalCreditCents: number;
  trialBalanceBalanced: boolean;
  balanceSheetBalanced: boolean;
  statementsConsistent: boolean;
  balanceSheetDifferenceCents: number;
}

/** Vue de balance dérivée et sérialisable ; aucune ligne d'écriture FEC n'est conservée. */
export interface StoredTrialBalance {
  rows: ReadonlyArray<{
    account: string;
    label: string;
    debitCents: number;
    creditCents: number;
    balanceCents: number;
  }>;
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  resultCents: number;
  revenueCents: number;
  chargesCents: number;
}

/** Copie structurelle du compte de résultat pur de @bob/core. */
export interface StoredIncomeStatement {
  exploitationProduitsCents: number;
  exploitationChargesCents: number;
  resultatExploitationCents: number;
  financierProduitsCents: number;
  financierChargesCents: number;
  resultatFinancierCents: number;
  resultatCourantCents: number;
  exceptionnelProduitsCents: number;
  exceptionnelChargesCents: number;
  resultatExceptionnelCents: number;
  participationCents: number;
  resultatNetAvantImpotCents: number;
  impotBeneficesCents: number;
  resultatNetCents: number;
}

/** Copie structurelle du bilan pur de @bob/core. */
export interface StoredBalanceSheet {
  actif: {
    immobilisationsNettesCents: number;
    stocksCents: number;
    creancesCents: number;
    disponibilitesCents: number;
    totalCents: number;
  };
  passif: {
    capitauxPropresCents: number;
    resultatNetCents: number;
    provisionsCents: number;
    empruntsCents: number;
    dettesCents: number;
    decouvertCents: number;
    totalCents: number;
  };
  balanced: boolean;
  ecartCents: number;
}

export interface StoredUnbalancedEntry {
  key: string;
  journalCode: string;
  entryNumber: string;
  entryDate: DateOnly;
  totalDebitCents: number;
  totalCreditCents: number;
  differenceCents: number;
}

export interface StoredFecChecks {
  entriesBalanced: boolean;
  trialBalanceBalanced: boolean;
  balanceSheetBalanced: boolean;
  resultConsistent: boolean;
  allPassed: boolean;
}

/**
 * Analyse persistée pour rouvrir les états après rechargement. Elle correspond à la sortie
 * structurée de `analyzeFec`, en excluant explicitement `ParsedFec.rows` et `entries`.
 */
export interface StoredFecAnalysis {
  trialBalance: StoredTrialBalance;
  incomeStatement: StoredIncomeStatement;
  balanceSheet: StoredBalanceSheet;
  turnoverCents: number;
  unbalancedEntries: readonly StoredUnbalancedEntry[];
  checks: StoredFecChecks;
}

export type CabinetReviewVerdict = 'ready' | 'reservations' | 'anomalies';

/** Résumé de la revue seulement ; les écritures et détails compte par compte ne sont pas persistés. */
export interface CabinetReviewSummary {
  verdict: CabinetReviewVerdict;
  okCount: number;
  attentionCount: number;
  anomalyCount: number;
  infoCount: number;
}

export function summarizeFecAnalysis(analysis: StoredFecAnalysis): CabinetFinancialSummary {
  return {
    turnoverCents: analysis.turnoverCents,
    resultCents: analysis.incomeStatement.resultatNetCents,
    totalDebitCents: analysis.trialBalance.totalDebitCents,
    totalCreditCents: analysis.trialBalance.totalCreditCents,
    trialBalanceBalanced: analysis.trialBalance.balanced,
    balanceSheetBalanced: analysis.balanceSheet.balanced,
    statementsConsistent: analysis.checks.resultConsistent,
    balanceSheetDifferenceCents: analysis.balanceSheet.ecartCents,
  };
}

/** Accepte structurellement la sortie ClosingReview de @bob/core sans en persister les contrôles détaillés. */
export function summarizeClosingReview(review: {
  okCount: number;
  attentionCount: number;
  anomalieCount: number;
  infoCount: number;
}): CabinetReviewSummary {
  return {
    verdict:
      review.anomalieCount > 0 ? 'anomalies' : review.attentionCount > 0 ? 'reservations' : 'ready',
    okCount: review.okCount,
    attentionCount: review.attentionCount,
    anomalyCount: review.anomalieCount,
    infoCount: review.infoCount,
  };
}

export interface CabinetDossier {
  /** Identifiant métier et clé d'upsert : neuf chiffres, sans espaces. */
  siren: string;
  clientName: string;
  sourceFileName: string;
  entryCount: number;
  rowCount: number;
  period: CabinetDossierPeriod;
  financial: CabinetFinancialSummary;
  analysis: StoredFecAnalysis;
  /** Null lorsque le moteur de revue n'a pas pu être exécuté. */
  review: CabinetReviewSummary | null;
  fiscal: CabinetFiscalProfile;
  /** Instant ISO injecté par l'appelant ; le domaine ne lit pas l'horloge. */
  lastImportedAt: string;
}
