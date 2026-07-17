import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CABINET_DOSSIER_MAX_TRIAL_BALANCE_ROWS = 50_000;
export const CABINET_DOSSIER_MAX_UNBALANCED_ENTRIES = 50_000;
export const CABINET_DOSSIER_PAGE_MAX = 100;

export type CabinetDossierActorRole = 'admin' | 'manager' | 'collaborator';
export type CabinetDossierReviewVerdict = 'ready' | 'reservations' | 'anomalies';

const safeInteger = z.number().int().safe();
const nonNegativeInteger = safeInteger.nonnegative();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'invalid_date');

function addSafe(values: readonly number[], context: z.RefinementCtx, path: (string | number)[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'integer_overflow', path });
      return null;
    }
  }
  return total;
}

function luhnValid(value: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function normalizeCabinetDossierSiren(value: string): string | null {
  const normalized = value.replace(/\s/g, '');
  return /^\d{9}$/.test(normalized) && luhnValid(normalized) ? normalized : null;
}

const nonBlankText = (max: number) =>
  z.string().max(max).refine((value) => value.trim().length > 0, 'required');

function isSafeSourceFileName(value: string): boolean {
  if (value.includes('/') || value.includes('\\')) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

const trialBalanceRowSchema = z.object({
  account: nonBlankText(50),
  label: z.string().max(500),
  debitCents: nonNegativeInteger,
  creditCents: nonNegativeInteger,
  balanceCents: safeInteger,
}).strict().superRefine((row, context) => {
  if (row.balanceCents !== row.debitCents - row.creditCents) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_balance', path: ['balanceCents'] });
  }
});

const trialBalanceSchema = z.object({
  rows: z.array(trialBalanceRowSchema).min(1).max(CABINET_DOSSIER_MAX_TRIAL_BALANCE_ROWS),
  totalDebitCents: nonNegativeInteger,
  totalCreditCents: nonNegativeInteger,
  balanced: z.boolean(),
  resultCents: safeInteger,
  revenueCents: safeInteger,
  chargesCents: safeInteger,
}).strict().superRefine((balance, context) => {
  const accounts = new Set<string>();
  for (let index = 0; index < balance.rows.length; index += 1) {
    const account = balance.rows[index]!.account;
    if (accounts.has(account)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate_account', path: ['rows', index, 'account'] });
    }
    accounts.add(account);
  }
  const totalDebit = addSafe(balance.rows.map((row) => row.debitCents), context, ['totalDebitCents']);
  const totalCredit = addSafe(balance.rows.map((row) => row.creditCents), context, ['totalCreditCents']);
  if (totalDebit !== null && balance.totalDebitCents !== totalDebit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_total', path: ['totalDebitCents'] });
  }
  if (totalCredit !== null && balance.totalCreditCents !== totalCredit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_total', path: ['totalCreditCents'] });
  }
  if (balance.balanced !== (balance.totalDebitCents === balance.totalCreditCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_verdict', path: ['balanced'] });
  }
  if (balance.resultCents !== balance.revenueCents - balance.chargesCents) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_result', path: ['resultCents'] });
  }
});

const incomeStatementSchema = z.object({
  exploitationProduitsCents: safeInteger,
  exploitationChargesCents: safeInteger,
  resultatExploitationCents: safeInteger,
  financierProduitsCents: safeInteger,
  financierChargesCents: safeInteger,
  resultatFinancierCents: safeInteger,
  resultatCourantCents: safeInteger,
  exceptionnelProduitsCents: safeInteger,
  exceptionnelChargesCents: safeInteger,
  resultatExceptionnelCents: safeInteger,
  participationCents: safeInteger,
  resultatNetAvantImpotCents: safeInteger,
  impotBeneficesCents: safeInteger,
  resultatNetCents: safeInteger,
}).strict().superRefine((statement, context) => {
  const expected = {
    resultatExploitationCents: statement.exploitationProduitsCents - statement.exploitationChargesCents,
    resultatFinancierCents: statement.financierProduitsCents - statement.financierChargesCents,
    resultatExceptionnelCents: statement.exceptionnelProduitsCents - statement.exceptionnelChargesCents,
  };
  const resultatCourantCents = expected.resultatExploitationCents + expected.resultatFinancierCents;
  const resultatNetAvantImpotCents = resultatCourantCents + expected.resultatExceptionnelCents - statement.participationCents;
  const resultatNetCents = resultatNetAvantImpotCents - statement.impotBeneficesCents;
  const checks: ReadonlyArray<[keyof typeof statement, number]> = [
    ['resultatExploitationCents', expected.resultatExploitationCents],
    ['resultatFinancierCents', expected.resultatFinancierCents],
    ['resultatCourantCents', resultatCourantCents],
    ['resultatExceptionnelCents', expected.resultatExceptionnelCents],
    ['resultatNetAvantImpotCents', resultatNetAvantImpotCents],
    ['resultatNetCents', resultatNetCents],
  ];
  for (const [field, value] of checks) {
    if (!Number.isSafeInteger(value) || statement[field] !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_result', path: [field] });
    }
  }
});

const actifSchema = z.object({
  immobilisationsNettesCents: safeInteger,
  stocksCents: safeInteger,
  creancesCents: safeInteger,
  disponibilitesCents: safeInteger,
  totalCents: safeInteger,
}).strict();

const passifSchema = z.object({
  capitauxPropresCents: safeInteger,
  resultatNetCents: safeInteger,
  provisionsCents: safeInteger,
  empruntsCents: safeInteger,
  dettesCents: safeInteger,
  decouvertCents: safeInteger,
  totalCents: safeInteger,
}).strict();

const balanceSheetSchema = z.object({
  actif: actifSchema,
  passif: passifSchema,
  balanced: z.boolean(),
  ecartCents: safeInteger,
}).strict().superRefine((sheet, context) => {
  const actifTotal = addSafe([
    sheet.actif.immobilisationsNettesCents,
    sheet.actif.stocksCents,
    sheet.actif.creancesCents,
    sheet.actif.disponibilitesCents,
  ], context, ['actif', 'totalCents']);
  const passifTotal = addSafe([
    sheet.passif.capitauxPropresCents,
    sheet.passif.resultatNetCents,
    sheet.passif.provisionsCents,
    sheet.passif.empruntsCents,
    sheet.passif.dettesCents,
    sheet.passif.decouvertCents,
  ], context, ['passif', 'totalCents']);
  if (actifTotal === null || passifTotal === null) return;
  if (sheet.actif.totalCents !== actifTotal) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_total', path: ['actif', 'totalCents'] });
  }
  if (sheet.passif.totalCents !== passifTotal) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_total', path: ['passif', 'totalCents'] });
  }
  if (sheet.ecartCents !== actifTotal - passifTotal) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_difference', path: ['ecartCents'] });
  }
  if (sheet.balanced !== (actifTotal === passifTotal)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_verdict', path: ['balanced'] });
  }
});

const unbalancedEntrySchema = z.object({
  key: nonBlankText(200),
  journalCode: nonBlankText(200),
  entryNumber: nonBlankText(200),
  entryDate: dateOnly,
  totalDebitCents: nonNegativeInteger,
  totalCreditCents: nonNegativeInteger,
  differenceCents: safeInteger,
}).strict().superRefine((entry, context) => {
  if (entry.differenceCents === 0 || entry.differenceCents !== entry.totalDebitCents - entry.totalCreditCents) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_difference', path: ['differenceCents'] });
  }
});

const fecChecksSchema = z.object({
  entriesBalanced: z.boolean(),
  trialBalanceBalanced: z.boolean(),
  balanceSheetBalanced: z.boolean(),
  resultConsistent: z.boolean(),
  allPassed: z.boolean(),
}).strict();

export const storedFecAnalysisSchema = z.object({
  trialBalance: trialBalanceSchema,
  incomeStatement: incomeStatementSchema,
  balanceSheet: balanceSheetSchema,
  turnoverCents: safeInteger,
  unbalancedEntries: z.array(unbalancedEntrySchema).max(CABINET_DOSSIER_MAX_UNBALANCED_ENTRIES),
  checks: fecChecksSchema,
}).strict().superRefine((analysis, context) => {
  const anomalyKeys = new Set<string>();
  for (let index = 0; index < analysis.unbalancedEntries.length; index += 1) {
    const key = analysis.unbalancedEntries[index]!.key;
    if (anomalyKeys.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate_entry', path: ['unbalancedEntries', index, 'key'] });
    }
    anomalyKeys.add(key);
  }
  const turnover = addSafe(
    analysis.trialBalance.rows
      .filter((row) => row.account.startsWith('70'))
      .map((row) => row.creditCents - row.debitCents),
    context,
    ['turnoverCents'],
  );
  if (turnover !== null && analysis.turnoverCents !== turnover) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_turnover', path: ['turnoverCents'] });
  }
  const resultConsistent =
    analysis.trialBalance.resultCents === analysis.incomeStatement.resultatNetCents
    && analysis.incomeStatement.resultatNetCents === analysis.balanceSheet.passif.resultatNetCents;
  const expected = {
    entriesBalanced: analysis.unbalancedEntries.length === 0,
    trialBalanceBalanced: analysis.trialBalance.balanced,
    balanceSheetBalanced: analysis.balanceSheet.balanced,
    resultConsistent,
  };
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
    if (analysis.checks[field] !== expected[field]) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_check', path: ['checks', field] });
    }
  }
  const allPassed = Object.values(expected).every(Boolean);
  if (analysis.checks.allPassed !== allPassed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_check', path: ['checks', 'allPassed'] });
  }
});

export const cabinetDossierReviewSchema = z.object({
  verdict: z.enum(['ready', 'reservations', 'anomalies']),
  okCount: nonNegativeInteger,
  attentionCount: nonNegativeInteger,
  anomalyCount: nonNegativeInteger,
  infoCount: nonNegativeInteger,
}).strict().superRefine((review, context) => {
  const expected: CabinetDossierReviewVerdict = review.anomalyCount > 0
    ? 'anomalies'
    : review.attentionCount > 0
      ? 'reservations'
      : 'ready';
  if (review.verdict !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent_verdict', path: ['verdict'] });
  }
  addSafe([review.okCount, review.attentionCount, review.anomalyCount, review.infoCount], context, []);
});

const fiscalYearEnd = z.string().regex(/^\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`2000-${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(5, 10) === value;
}, 'invalid_month_day').nullable();

export const cabinetDossierFiscalProfileSchema = z.object({
  legalForm: z.enum(['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro']),
  vatRegime: z.enum(['franchise', 'reel_simpl', 'reel_normal']),
  incomeTaxRegime: z.enum(['IR', 'IS']),
  fiscalYearEnd,
  urssafPeriodicity: z.enum(['monthly', 'quarterly']).nullable(),
  dateCreation: dateOnly.nullable(),
}).strict();

const periodSchema = z.object({ from: dateOnly, to: dateOnly }).strict().refine(
  (period) => period.from <= period.to,
  { message: 'invalid_period', path: ['to'] },
);

export const cabinetDossierUpsertInputSchema = z.object({
  siren: z.string().transform((value, context) => {
    const normalized = normalizeCabinetDossierSiren(value);
    if (normalized === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_siren' });
      return z.NEVER;
    }
    return normalized;
  }),
  clientName: nonBlankText(200).transform((value) => value.trim().replace(/\s+/g, ' ')),
  sourceFileName: nonBlankText(255).refine(isSafeSourceFileName, 'invalid_file_name'),
  entryCount: nonNegativeInteger.positive().max(2_147_483_647),
  rowCount: nonNegativeInteger.positive().max(2_147_483_647),
  period: periodSchema,
  analysis: storedFecAnalysisSchema,
  review: cabinetDossierReviewSchema.nullable(),
  fiscal: cabinetDossierFiscalProfileSchema,
  expectedRevision: z.union([z.null(), safeInteger.positive()]),
}).strict().superRefine((input, context) => {
  if (input.rowCount < input.entryCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'row_count_below_entry_count', path: ['rowCount'] });
  }
});

export type StoredFecAnalysis = z.infer<typeof storedFecAnalysisSchema>;
export type CabinetDossierUpsertInput = z.infer<typeof cabinetDossierUpsertInputSchema>;
export type CabinetDossierReviewSummary = z.infer<typeof cabinetDossierReviewSchema>;
export type CabinetDossierFiscalProfile = z.infer<typeof cabinetDossierFiscalProfileSchema>;
export type CabinetDossierPeriod = z.infer<typeof periodSchema>;

export interface CabinetDossierFinancialSummary {
  turnoverCents: number;
  resultCents: number;
  totalDebitCents: number;
  totalCreditCents: number;
  trialBalanceBalanced: boolean;
  balanceSheetBalanced: boolean;
  statementsConsistent: boolean;
  balanceSheetDifferenceCents: number;
}

export function deriveCabinetDossierFinancialSummary(
  analysis: StoredFecAnalysis,
): CabinetDossierFinancialSummary {
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

/** Le JSON provient de la sortie Zod, donc l'ordre des clés est canonique et reproductible. */
export function cabinetDossierAnalysisSha256(analysis: StoredFecAnalysis): string {
  return createHash('sha256').update(JSON.stringify(analysis), 'utf8').digest('hex');
}

export interface CabinetDossierSummary {
  id: string;
  cabinetId: string;
  siren: string;
  clientName: string;
  sourceFileName: string;
  entryCount: number;
  rowCount: number;
  period: CabinetDossierPeriod;
  financial: CabinetDossierFinancialSummary;
  review: CabinetDossierReviewSummary | null;
  fiscal: CabinetDossierFiscalProfile;
  lastImportedAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CabinetDossier extends CabinetDossierSummary {
  analysis: StoredFecAnalysis;
  analysisSha256: string;
}
