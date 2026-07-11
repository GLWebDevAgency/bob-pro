import type {
  CabinetDossier,
  CabinetFiscalProfile,
  CabinetFinancialSummary,
  CabinetReviewSummary,
  CabinetStateV1,
  StoredFecAnalysis,
  StoredIncomeStatement,
  StoredTrialBalance,
} from './types';
import { CABINET_STATE_VERSION, createEmptyCabinetState } from './types';

export const CABINET_STORAGE_KEY = 'bobcabinet.v1';

/** Sous-ensemble de Storage injecté pour rester testable et compatible avec le rendu serveur. */
export interface CabinetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type CabinetStorageErrorCode =
  | 'invalid_json'
  | 'invalid_state'
  | 'unsupported_version'
  | 'storage_unavailable'
  | 'quota_exceeded'
  | 'write_failed';

export interface CabinetStorageError {
  code: CabinetStorageErrorCode;
  message: string;
  path?: string;
}

export type CabinetStorageResult<T> =
  { ok: true; value: T } | { ok: false; error: CabinetStorageError };

const LEGAL_FORMS = new Set(['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro']);
const VAT_REGIMES = new Set(['franchise', 'reel_simpl', 'reel_normal']);
const INCOME_TAX_REGIMES = new Set(['IR', 'IS']);
const URSSAF_PERIODICITIES = new Set(['monthly', 'quarterly']);
const REVIEW_VERDICTS = new Set(['ready', 'reservations', 'anomalies']);
const MAX_DOSSIERS = 5_000;

interface ValidationIssue {
  message: string;
  path: string;
  code?: 'unsupported_version';
}

function success<T>(value: T): CabinetStorageResult<T> {
  return { ok: true, value };
}

function failure(
  code: CabinetStorageErrorCode,
  message: string,
  path?: string,
): CabinetStorageResult<never> {
  return { ok: false, error: { code, message, ...(path === undefined ? {} : { path }) } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): ValidationIssue | null {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length === wanted.length && actual.every((key, index) => key === wanted[index]))
    return null;
  return {
    path,
    message: `Champs invalides : attendus [${wanted.join(', ')}], reçus [${actual.join(', ')}].`,
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNonBlankText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidInstant(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return parsed.toISOString() === canonical;
}

function isValidFiscalYearEnd(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) return false;
  return isValidDateOnly(`2000-${value}`);
}

function luhnValid(value: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = value.charCodeAt(index) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function normalizeSiren(value: string): string | null {
  const normalized = value.replace(/\s/g, '');
  return /^\d{9}$/.test(normalized) && luhnValid(normalized) ? normalized : null;
}

function validatePeriod(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'La période doit être un objet.' };
  const keysIssue = hasExactKeys(value, ['from', 'to'], path);
  if (keysIssue) return keysIssue;
  if (!isValidDateOnly(value.from))
    return { path: `${path}.from`, message: 'Date de début invalide.' };
  if (!isValidDateOnly(value.to)) return { path: `${path}.to`, message: 'Date de fin invalide.' };
  if (value.from > value.to)
    return { path, message: 'La date de début doit précéder la date de fin.' };
  return null;
}

function validateFinancial(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'La synthèse financière doit être un objet.' };
  const keysIssue = hasExactKeys(
    value,
    [
      'turnoverCents',
      'resultCents',
      'totalDebitCents',
      'totalCreditCents',
      'trialBalanceBalanced',
      'balanceSheetBalanced',
      'statementsConsistent',
      'balanceSheetDifferenceCents',
    ],
    path,
  );
  if (keysIssue) return keysIssue;

  for (const field of ['turnoverCents', 'resultCents', 'balanceSheetDifferenceCents'] as const) {
    if (!isSafeInteger(value[field])) {
      return {
        path: `${path}.${field}`,
        message: 'Le montant doit être exprimé en centimes entiers.',
      };
    }
  }
  for (const field of ['totalDebitCents', 'totalCreditCents'] as const) {
    if (!isNonNegativeInteger(value[field])) {
      return { path: `${path}.${field}`, message: 'Le total doit être un entier positif ou nul.' };
    }
  }
  for (const field of [
    'trialBalanceBalanced',
    'balanceSheetBalanced',
    'statementsConsistent',
  ] as const) {
    if (!isBoolean(value[field]))
      return { path: `${path}.${field}`, message: 'Un booléen est attendu.' };
  }
  if (value.trialBalanceBalanced !== (value.totalDebitCents === value.totalCreditCents)) {
    return { path, message: 'Le statut de la balance contredit les totaux débit et crédit.' };
  }
  if (value.balanceSheetBalanced !== (value.balanceSheetDifferenceCents === 0)) {
    return { path, message: "Le statut du bilan contredit l'écart actif/passif." };
  }
  return null;
}

function validateTrialBalance(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'La balance doit être un objet.' };
  const keysIssue = hasExactKeys(
    value,
    [
      'rows',
      'totalDebitCents',
      'totalCreditCents',
      'balanced',
      'resultCents',
      'revenueCents',
      'chargesCents',
    ],
    path,
  );
  if (keysIssue) return keysIssue;
  if (!Array.isArray(value.rows))
    return { path: `${path}.rows`, message: 'Les lignes de balance sont requises.' };
  if (value.rows.length > 50_000) {
    return { path: `${path}.rows`, message: 'La balance dépasse 50 000 comptes.' };
  }

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  for (let index = 0; index < value.rows.length; index += 1) {
    const row = value.rows[index];
    const rowPath = `${path}.rows[${index}]`;
    if (!isPlainRecord(row))
      return { path: rowPath, message: 'La ligne de balance doit être un objet.' };
    const rowKeysIssue = hasExactKeys(
      row,
      ['account', 'label', 'debitCents', 'creditCents', 'balanceCents'],
      rowPath,
    );
    if (rowKeysIssue) return rowKeysIssue;
    if (!isNonBlankText(row.account, 50)) {
      return { path: `${rowPath}.account`, message: 'Numéro de compte invalide.' };
    }
    if (typeof row.label !== 'string' || row.label.length > 500) {
      return { path: `${rowPath}.label`, message: 'Libellé de compte invalide.' };
    }
    if (!isNonNegativeInteger(row.debitCents) || !isNonNegativeInteger(row.creditCents)) {
      return {
        path: rowPath,
        message: 'Débit et crédit doivent être des centimes positifs ou nuls.',
      };
    }
    if (!isSafeInteger(row.balanceCents) || row.balanceCents !== row.debitCents - row.creditCents) {
      return {
        path: `${rowPath}.balanceCents`,
        message: 'Le solde du compte contredit son débit et son crédit.',
      };
    }
    totalDebitCents += row.debitCents;
    totalCreditCents += row.creditCents;
    if (!Number.isSafeInteger(totalDebitCents) || !Number.isSafeInteger(totalCreditCents)) {
      return {
        path: `${path}.rows`,
        message: 'Les totaux dépassent la précision entière disponible.',
      };
    }
  }

  for (const field of ['totalDebitCents', 'totalCreditCents'] as const) {
    if (!isNonNegativeInteger(value[field])) {
      return { path: `${path}.${field}`, message: 'Le total doit être un entier positif ou nul.' };
    }
  }
  for (const field of ['resultCents', 'revenueCents', 'chargesCents'] as const) {
    if (!isSafeInteger(value[field])) {
      return {
        path: `${path}.${field}`,
        message: 'Le montant doit être exprimé en centimes entiers.',
      };
    }
  }
  if (!isBoolean(value.balanced))
    return { path: `${path}.balanced`, message: 'Un booléen est attendu.' };
  const balance = value as unknown as StoredTrialBalance;
  if (
    balance.totalDebitCents !== totalDebitCents ||
    balance.totalCreditCents !== totalCreditCents
  ) {
    return { path, message: 'Les totaux de balance ne correspondent pas aux comptes persistés.' };
  }
  if (balance.balanced !== (totalDebitCents === totalCreditCents)) {
    return { path, message: 'Le statut de la balance contredit ses totaux.' };
  }
  if (balance.resultCents !== balance.revenueCents - balance.chargesCents) {
    return { path, message: 'Le résultat de la balance contredit produits et charges.' };
  }
  return null;
}

const INCOME_STATEMENT_FIELDS = [
  'exploitationProduitsCents',
  'exploitationChargesCents',
  'resultatExploitationCents',
  'financierProduitsCents',
  'financierChargesCents',
  'resultatFinancierCents',
  'resultatCourantCents',
  'exceptionnelProduitsCents',
  'exceptionnelChargesCents',
  'resultatExceptionnelCents',
  'participationCents',
  'resultatNetAvantImpotCents',
  'impotBeneficesCents',
  'resultatNetCents',
] as const;

function validateIncomeStatement(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'Le compte de résultat doit être un objet.' };
  const keysIssue = hasExactKeys(value, INCOME_STATEMENT_FIELDS, path);
  if (keysIssue) return keysIssue;
  for (const field of INCOME_STATEMENT_FIELDS) {
    if (!isSafeInteger(value[field])) {
      return {
        path: `${path}.${field}`,
        message: 'Le montant doit être exprimé en centimes entiers.',
      };
    }
  }
  const statement = value as unknown as StoredIncomeStatement;
  if (
    statement.resultatExploitationCents !==
    statement.exploitationProduitsCents - statement.exploitationChargesCents
  ) {
    return { path, message: "Le résultat d'exploitation est incohérent." };
  }
  if (
    statement.resultatFinancierCents !==
    statement.financierProduitsCents - statement.financierChargesCents
  ) {
    return { path, message: 'Le résultat financier est incohérent.' };
  }
  if (
    statement.resultatCourantCents !==
    statement.resultatExploitationCents + statement.resultatFinancierCents
  ) {
    return { path, message: 'Le résultat courant est incohérent.' };
  }
  if (
    statement.resultatExceptionnelCents !==
    statement.exceptionnelProduitsCents - statement.exceptionnelChargesCents
  ) {
    return { path, message: 'Le résultat exceptionnel est incohérent.' };
  }
  if (
    statement.resultatNetAvantImpotCents !==
    statement.resultatCourantCents +
      statement.resultatExceptionnelCents -
      statement.participationCents
  ) {
    return { path, message: 'Le résultat avant impôt est incohérent.' };
  }
  if (
    statement.resultatNetCents !==
    statement.resultatNetAvantImpotCents - statement.impotBeneficesCents
  ) {
    return { path, message: 'Le résultat net est incohérent.' };
  }
  return null;
}

function validateBalanceSide(
  value: unknown,
  fields: readonly string[],
  path: string,
): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'Le côté du bilan doit être un objet.' };
  const keysIssue = hasExactKeys(value, fields, path);
  if (keysIssue) return keysIssue;
  for (const field of fields) {
    if (!isSafeInteger(value[field])) {
      return {
        path: `${path}.${field}`,
        message: 'Le montant doit être exprimé en centimes entiers.',
      };
    }
  }
  return null;
}

function validateBalanceSheet(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'Le bilan doit être un objet.' };
  const keysIssue = hasExactKeys(value, ['actif', 'passif', 'balanced', 'ecartCents'], path);
  if (keysIssue) return keysIssue;
  const actifFields = [
    'immobilisationsNettesCents',
    'stocksCents',
    'creancesCents',
    'disponibilitesCents',
    'totalCents',
  ] as const;
  const passifFields = [
    'capitauxPropresCents',
    'resultatNetCents',
    'provisionsCents',
    'empruntsCents',
    'dettesCents',
    'decouvertCents',
    'totalCents',
  ] as const;
  const actifIssue = validateBalanceSide(value.actif, actifFields, `${path}.actif`);
  if (actifIssue) return actifIssue;
  const passifIssue = validateBalanceSide(value.passif, passifFields, `${path}.passif`);
  if (passifIssue) return passifIssue;
  if (!isBoolean(value.balanced))
    return { path: `${path}.balanced`, message: 'Un booléen est attendu.' };
  if (!isSafeInteger(value.ecartCents)) {
    return {
      path: `${path}.ecartCents`,
      message: "L'écart doit être exprimé en centimes entiers.",
    };
  }
  const actif = value.actif as Record<(typeof actifFields)[number], number>;
  const passif = value.passif as Record<(typeof passifFields)[number], number>;
  const actifTotal =
    actif.immobilisationsNettesCents +
    actif.stocksCents +
    actif.creancesCents +
    actif.disponibilitesCents;
  const passifTotal =
    passif.capitauxPropresCents +
    passif.resultatNetCents +
    passif.provisionsCents +
    passif.empruntsCents +
    passif.dettesCents +
    passif.decouvertCents;
  if (actif.totalCents !== actifTotal || passif.totalCents !== passifTotal) {
    return { path, message: 'Un total du bilan est incohérent.' };
  }
  if (
    value.ecartCents !== actifTotal - passifTotal ||
    value.balanced !== (actifTotal === passifTotal)
  ) {
    return { path, message: "Le statut du bilan contredit l'actif et le passif." };
  }
  return null;
}

function validateChecks(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'Les contrôles FEC doivent être un objet.' };
  const fields = [
    'entriesBalanced',
    'trialBalanceBalanced',
    'balanceSheetBalanced',
    'resultConsistent',
    'allPassed',
  ] as const;
  const keysIssue = hasExactKeys(value, fields, path);
  if (keysIssue) return keysIssue;
  for (const field of fields) {
    if (!isBoolean(value[field]))
      return { path: `${path}.${field}`, message: 'Un booléen est attendu.' };
  }
  if (
    value.allPassed !==
    (value.entriesBalanced &&
      value.trialBalanceBalanced &&
      value.balanceSheetBalanced &&
      value.resultConsistent)
  ) {
    return { path, message: 'Le verdict global contredit les contrôles détaillés.' };
  }
  return null;
}

function validateUnbalancedEntries(value: unknown, path: string): ValidationIssue | null {
  if (!Array.isArray(value))
    return { path, message: 'La liste des écritures déséquilibrées est requise.' };
  if (value.length > 50_000)
    return { path, message: 'La liste des anomalies dépasse 50 000 écritures.' };
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isPlainRecord(item)) return { path: itemPath, message: "L'anomalie doit être un objet." };
    const keysIssue = hasExactKeys(
      item,
      [
        'key',
        'journalCode',
        'entryNumber',
        'entryDate',
        'totalDebitCents',
        'totalCreditCents',
        'differenceCents',
      ],
      itemPath,
    );
    if (keysIssue) return keysIssue;
    for (const field of ['key', 'journalCode', 'entryNumber'] as const) {
      if (!isNonBlankText(item[field], 200)) {
        return { path: `${itemPath}.${field}`, message: 'Identifiant d’écriture invalide.' };
      }
    }
    if (!isValidDateOnly(item.entryDate)) {
      return { path: `${itemPath}.entryDate`, message: "Date d'écriture invalide." };
    }
    if (
      !isNonNegativeInteger(item.totalDebitCents) ||
      !isNonNegativeInteger(item.totalCreditCents)
    ) {
      return { path: itemPath, message: 'Les totaux doivent être des centimes positifs ou nuls.' };
    }
    if (!isSafeInteger(item.differenceCents)) {
      return {
        path: `${itemPath}.differenceCents`,
        message: "L'écart doit être exprimé en centimes entiers.",
      };
    }
  }
  return null;
}

function validateAnalysis(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: "L'analyse FEC doit être un objet." };
  const keysIssue = hasExactKeys(
    value,
    [
      'trialBalance',
      'incomeStatement',
      'balanceSheet',
      'turnoverCents',
      'unbalancedEntries',
      'checks',
    ],
    path,
  );
  if (keysIssue) return keysIssue;
  const trialBalanceIssue = validateTrialBalance(value.trialBalance, `${path}.trialBalance`);
  if (trialBalanceIssue) return trialBalanceIssue;
  const incomeStatementIssue = validateIncomeStatement(
    value.incomeStatement,
    `${path}.incomeStatement`,
  );
  if (incomeStatementIssue) return incomeStatementIssue;
  const balanceSheetIssue = validateBalanceSheet(value.balanceSheet, `${path}.balanceSheet`);
  if (balanceSheetIssue) return balanceSheetIssue;
  if (!isSafeInteger(value.turnoverCents)) {
    return {
      path: `${path}.turnoverCents`,
      message: 'Le chiffre d’affaires doit être en centimes entiers.',
    };
  }
  const entriesIssue = validateUnbalancedEntries(
    value.unbalancedEntries,
    `${path}.unbalancedEntries`,
  );
  if (entriesIssue) return entriesIssue;
  const checksIssue = validateChecks(value.checks, `${path}.checks`);
  if (checksIssue) return checksIssue;

  const trialBalance = value.trialBalance as Record<string, unknown>;
  const incomeStatement = value.incomeStatement as Record<string, unknown>;
  const balanceSheet = value.balanceSheet as Record<string, unknown>;
  const passif = balanceSheet.passif as Record<string, unknown>;
  const checks = value.checks as Record<string, unknown>;
  if (
    trialBalance.resultCents !== incomeStatement.resultatNetCents ||
    incomeStatement.resultatNetCents !== passif.resultatNetCents
  ) {
    if (checks.resultConsistent !== false) {
      return { path, message: 'Les résultats divergent mais le contrôle les déclare cohérents.' };
    }
  } else if (checks.resultConsistent !== true) {
    return { path, message: 'Les résultats concordent mais le contrôle les déclare incohérents.' };
  }
  if (checks.entriesBalanced !== ((value.unbalancedEntries as unknown[]).length === 0)) {
    return { path, message: 'Le contrôle des écritures contredit la liste des anomalies.' };
  }
  if (
    checks.trialBalanceBalanced !== trialBalance.balanced ||
    checks.balanceSheetBalanced !== balanceSheet.balanced
  ) {
    return { path, message: 'Les contrôles contredisent les états financiers.' };
  }
  return null;
}

function validateReview(value: unknown, path: string): ValidationIssue | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) return { path, message: 'La revue doit être un objet ou null.' };
  const keysIssue = hasExactKeys(
    value,
    ['verdict', 'okCount', 'attentionCount', 'anomalyCount', 'infoCount'],
    path,
  );
  if (keysIssue) return keysIssue;
  if (typeof value.verdict !== 'string' || !REVIEW_VERDICTS.has(value.verdict)) {
    return { path: `${path}.verdict`, message: 'Verdict de revue inconnu.' };
  }
  for (const field of ['okCount', 'attentionCount', 'anomalyCount', 'infoCount'] as const) {
    if (!isNonNegativeInteger(value[field])) {
      return {
        path: `${path}.${field}`,
        message: 'Le compteur doit être un entier positif ou nul.',
      };
    }
  }
  const review = value as unknown as CabinetReviewSummary;
  const expectedVerdict =
    review.anomalyCount > 0 ? 'anomalies' : review.attentionCount > 0 ? 'reservations' : 'ready';
  if (review.verdict !== expectedVerdict) {
    return { path, message: 'Le verdict de revue contredit les compteurs.' };
  }
  return null;
}

function validateFiscal(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value))
    return { path, message: 'Les paramètres fiscaux doivent être un objet.' };
  const keysIssue = hasExactKeys(
    value,
    [
      'legalForm',
      'vatRegime',
      'incomeTaxRegime',
      'fiscalYearEnd',
      'urssafPeriodicity',
      'dateCreation',
    ],
    path,
  );
  if (keysIssue) return keysIssue;
  if (typeof value.legalForm !== 'string' || !LEGAL_FORMS.has(value.legalForm)) {
    return { path: `${path}.legalForm`, message: 'Forme juridique inconnue.' };
  }
  if (typeof value.vatRegime !== 'string' || !VAT_REGIMES.has(value.vatRegime)) {
    return { path: `${path}.vatRegime`, message: 'Régime de TVA inconnu.' };
  }
  if (typeof value.incomeTaxRegime !== 'string' || !INCOME_TAX_REGIMES.has(value.incomeTaxRegime)) {
    return { path: `${path}.incomeTaxRegime`, message: "Régime d'imposition inconnu." };
  }
  if (!isValidFiscalYearEnd(value.fiscalYearEnd)) {
    return {
      path: `${path}.fiscalYearEnd`,
      message: 'Date de clôture attendue au format MM-JJ ou null.',
    };
  }
  if (
    value.urssafPeriodicity !== null &&
    (typeof value.urssafPeriodicity !== 'string' ||
      !URSSAF_PERIODICITIES.has(value.urssafPeriodicity))
  ) {
    return { path: `${path}.urssafPeriodicity`, message: 'Périodicité URSSAF inconnue.' };
  }
  if (value.dateCreation !== null && !isValidDateOnly(value.dateCreation)) {
    return { path: `${path}.dateCreation`, message: 'Date de création invalide.' };
  }
  return null;
}

function validateDossier(value: unknown, path: string): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path, message: 'Le dossier doit être un objet.' };
  const keysIssue = hasExactKeys(
    value,
    [
      'siren',
      'clientName',
      'sourceFileName',
      'entryCount',
      'rowCount',
      'period',
      'financial',
      'analysis',
      'review',
      'fiscal',
      'lastImportedAt',
    ],
    path,
  );
  if (keysIssue) return keysIssue;
  if (typeof value.siren !== 'string' || normalizeSiren(value.siren) !== value.siren) {
    return {
      path: `${path}.siren`,
      message: 'SIREN invalide : neuf chiffres et clé de contrôle attendus.',
    };
  }
  if (!isNonBlankText(value.clientName, 200)) {
    return { path: `${path}.clientName`, message: 'Nom client requis (200 caractères maximum).' };
  }
  if (!isNonBlankText(value.sourceFileName, 255)) {
    return {
      path: `${path}.sourceFileName`,
      message: 'Nom du fichier source requis (255 caractères maximum).',
    };
  }
  if (
    !isNonNegativeInteger(value.entryCount) ||
    !isNonNegativeInteger(value.rowCount) ||
    value.entryCount === 0 ||
    value.rowCount < value.entryCount
  ) {
    return {
      path,
      message:
        'Le dossier doit contenir au moins une écriture et autant de lignes que d’écritures.',
    };
  }
  const periodIssue = validatePeriod(value.period, `${path}.period`);
  if (periodIssue) return periodIssue;
  const financialIssue = validateFinancial(value.financial, `${path}.financial`);
  if (financialIssue) return financialIssue;
  const analysisIssue = validateAnalysis(value.analysis, `${path}.analysis`);
  if (analysisIssue) return analysisIssue;
  const reviewIssue = validateReview(value.review, `${path}.review`);
  if (reviewIssue) return reviewIssue;
  const fiscalIssue = validateFiscal(value.fiscal, `${path}.fiscal`);
  if (fiscalIssue) return fiscalIssue;
  if (!isValidInstant(value.lastImportedAt)) {
    return { path: `${path}.lastImportedAt`, message: 'Instant ISO UTC invalide.' };
  }
  const financial = value.financial as CabinetFinancialSummary;
  const analysis = value.analysis as StoredFecAnalysis;
  if (
    financial.turnoverCents !== analysis.turnoverCents ||
    financial.resultCents !== analysis.incomeStatement.resultatNetCents ||
    financial.totalDebitCents !== analysis.trialBalance.totalDebitCents ||
    financial.totalCreditCents !== analysis.trialBalance.totalCreditCents ||
    financial.trialBalanceBalanced !== analysis.trialBalance.balanced ||
    financial.balanceSheetBalanced !== analysis.balanceSheet.balanced ||
    financial.statementsConsistent !== analysis.checks.resultConsistent ||
    financial.balanceSheetDifferenceCents !== analysis.balanceSheet.ecartCents
  ) {
    return { path, message: "La synthèse du portefeuille contredit l'analyse FEC persistée." };
  }
  return null;
}

function validateState(value: unknown): ValidationIssue | null {
  if (!isPlainRecord(value)) return { path: '$', message: "L'état cabinet doit être un objet." };
  const keysIssue = hasExactKeys(value, ['version', 'dossiers'], '$');
  if (keysIssue) return keysIssue;
  if (value.version !== CABINET_STATE_VERSION) {
    return {
      code: 'unsupported_version',
      path: '$.version',
      message: `Version non prise en charge : ${String(value.version)}.`,
    };
  }
  if (!Array.isArray(value.dossiers))
    return { path: '$.dossiers', message: 'Une liste de dossiers est attendue.' };
  if (value.dossiers.length > MAX_DOSSIERS) {
    return {
      path: '$.dossiers',
      message: `Le fichier dépasse la limite de ${MAX_DOSSIERS} dossiers.`,
    };
  }
  const sirens = new Set<string>();
  for (let index = 0; index < value.dossiers.length; index += 1) {
    const dossier = value.dossiers[index];
    const issue = validateDossier(dossier, `$.dossiers[${index}]`);
    if (issue) return issue;
    const siren = (dossier as { siren: string }).siren;
    if (sirens.has(siren)) {
      return {
        path: `$.dossiers[${index}].siren`,
        message: 'Deux dossiers portent le même SIREN.',
      };
    }
    sirens.add(siren);
  }
  return null;
}

function cloneFinancial(financial: CabinetFinancialSummary): CabinetFinancialSummary {
  return { ...financial };
}

function cloneReview(review: CabinetReviewSummary | null): CabinetReviewSummary | null {
  return review === null ? null : { ...review };
}

function cloneFiscal(fiscal: CabinetFiscalProfile): CabinetFiscalProfile {
  return { ...fiscal };
}

function cloneAnalysis(analysis: StoredFecAnalysis): StoredFecAnalysis {
  return {
    trialBalance: {
      ...analysis.trialBalance,
      rows: analysis.trialBalance.rows.map((row) => ({ ...row })),
    },
    incomeStatement: { ...analysis.incomeStatement },
    balanceSheet: {
      ...analysis.balanceSheet,
      actif: { ...analysis.balanceSheet.actif },
      passif: { ...analysis.balanceSheet.passif },
    },
    turnoverCents: analysis.turnoverCents,
    unbalancedEntries: analysis.unbalancedEntries.map((entry) => ({ ...entry })),
    checks: { ...analysis.checks },
  };
}

function cloneDossier(dossier: CabinetDossier): CabinetDossier {
  return {
    ...dossier,
    period: { ...dossier.period },
    financial: cloneFinancial(dossier.financial),
    analysis: cloneAnalysis(dossier.analysis),
    review: cloneReview(dossier.review),
    fiscal: cloneFiscal(dossier.fiscal),
  };
}

function cloneState(state: CabinetStateV1): CabinetStateV1 {
  return { version: CABINET_STATE_VERSION, dossiers: state.dossiers.map(cloneDossier) };
}

export function validateCabinetState(value: unknown): CabinetStorageResult<CabinetStateV1> {
  const issue = validateState(value);
  if (issue) return failure(issue.code ?? 'invalid_state', issue.message, issue.path);
  return success(cloneState(value as CabinetStateV1));
}

export function parseCabinetStateJson(raw: string): CabinetStorageResult<CabinetStateV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return failure('invalid_json', "Le fichier n'est pas un JSON valide.");
  }
  return validateCabinetState(parsed);
}

export function loadCabinetState(storage: CabinetStorage): CabinetStorageResult<CabinetStateV1> {
  let raw: string | null;
  try {
    raw = storage.getItem(CABINET_STORAGE_KEY);
  } catch {
    return failure(
      'storage_unavailable',
      "Le stockage local n'est pas accessible dans ce navigateur.",
    );
  }
  return raw === null ? success(createEmptyCabinetState()) : parseCabinetStateJson(raw);
}

function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 22 ||
    candidate.code === 1014
  );
}

export function saveCabinetState(
  storage: CabinetStorage,
  state: CabinetStateV1,
): CabinetStorageResult<CabinetStateV1> {
  const validated = validateCabinetState(state);
  if (!validated.ok) return validated;
  try {
    storage.setItem(CABINET_STORAGE_KEY, JSON.stringify(validated.value));
  } catch (error) {
    if (isQuotaExceeded(error)) {
      return failure(
        'quota_exceeded',
        "L'espace de stockage local est plein. Exportez vos dossiers, puis supprimez ceux devenus inutiles.",
      );
    }
    return failure('write_failed', "Impossible d'enregistrer les dossiers dans ce navigateur.");
  }
  return validated;
}

export function exportCabinetStateJson(state: CabinetStateV1): CabinetStorageResult<string> {
  const validated = validateCabinetState(state);
  return validated.ok ? success(JSON.stringify(validated.value, null, 2)) : validated;
}

/** Valide intégralement avant la seule mutation : un import invalide ne touche jamais au stockage. */
export function importCabinetStateJson(
  storage: CabinetStorage,
  raw: string,
): CabinetStorageResult<CabinetStateV1> {
  const parsed = parseCabinetStateJson(raw);
  if (!parsed.ok) return parsed;
  return saveCabinetState(storage, parsed.value);
}

/** Upsert immuable par SIREN ; conserve la position d'un dossier mis à jour. */
export function upsertDossier(state: CabinetStateV1, dossier: CabinetDossier): CabinetStateV1 {
  const normalizedSiren = normalizeSiren(dossier.siren) ?? dossier.siren;
  const normalizedDossier = cloneDossier({ ...dossier, siren: normalizedSiren });
  const next = state.dossiers.map(cloneDossier);
  const index = next.findIndex((candidate) => candidate.siren === normalizedSiren);
  if (index === -1) next.push(normalizedDossier);
  else next[index] = normalizedDossier;
  return { version: CABINET_STATE_VERSION, dossiers: next };
}

export function deleteDossier(state: CabinetStateV1, siren: string): CabinetStateV1 {
  const normalized = normalizeSiren(siren);
  if (normalized === null) return cloneState(state);
  return {
    version: CABINET_STATE_VERSION,
    dossiers: state.dossiers.filter((dossier) => dossier.siren !== normalized).map(cloneDossier),
  };
}

export function upsertStoredDossier(
  storage: CabinetStorage,
  dossier: CabinetDossier,
): CabinetStorageResult<CabinetStateV1> {
  const current = loadCabinetState(storage);
  if (!current.ok) return current;
  return saveCabinetState(storage, upsertDossier(current.value, dossier));
}

export function deleteStoredDossier(
  storage: CabinetStorage,
  siren: string,
): CabinetStorageResult<CabinetStateV1> {
  const current = loadCabinetState(storage);
  if (!current.ok) return current;
  return saveCabinetState(storage, deleteDossier(current.value, siren));
}
