import { type DomainResult, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type Expense, type ExpenseCategory } from '../expense/expense';
import { AccountingEntry, type AccountingEntryLineProps } from './accounting-entry';
import { type ChartOfAccounts } from './chart-of-accounts';

/**
 * Écritures du CYCLE ACHATS (journal AC) — miroir de invoice-accounting.ts côté ventes.
 * Sans elles, le FEC n'est pas exhaustif (art. A47 A-1 LPF), le résultat est faux
 * (produits sans charges) et la TVA déductible portée en CA3 n'est pas justifiée au
 * grand-livre (art. 271 CGI : la déduction suppose facture ET comptabilisation).
 */

export type ExpenseChargeAccountMap = Record<ExpenseCategory, string>;

export interface ExpenseAccountingAccounts {
  /** 401 Fournisseurs. */
  supplier: string;
  /** 44566 TVA déductible sur autres biens et services. */
  vatDeductible: string;
  /** 512 Banques (décaissement) — PayExpense affinera par mode de paiement (530 espèces). */
  bank: string;
  chargeByCategory: ExpenseChargeAccountMap;
}

/**
 * Mapping catégorie → compte de charge (PCG, comptes POSTABLES du plan opérationnel seedé).
 * Positions retenues (à faire valider par l'expert-comptable du cabinet) :
 * · fournitures/carburant/autre → 606 Achats non stockés (subdivisions 6061/6063 en évolution) ;
 * · materiel → 606 : petit équipement — AU-DELÀ de la tolérance ~500 € HT c'est une
 *   IMMOBILISATION (215x, TVA au 44562), hors périmètre de cette écriture de charge ;
 * · repas → 625 Déplacements, missions et réceptions ;
 * · sous_traitance → 611 Sous-traitance générale.
 */
export const DEFAULT_EXPENSE_ACCOUNTING_ACCOUNTS: ExpenseAccountingAccounts = {
  supplier: '401',
  vatDeductible: '44566',
  bank: '512',
  chargeByCategory: {
    fournitures: '606',
    materiel: '606',
    carburant: '606',
    repas: '625',
    sous_traitance: '611',
    autre: '606',
  },
};

function mergeAccounts(overrides: Partial<ExpenseAccountingAccounts> | undefined): ExpenseAccountingAccounts {
  return {
    supplier: overrides?.supplier ?? DEFAULT_EXPENSE_ACCOUNTING_ACCOUNTS.supplier,
    vatDeductible: overrides?.vatDeductible ?? DEFAULT_EXPENSE_ACCOUNTING_ACCOUNTS.vatDeductible,
    bank: overrides?.bank ?? DEFAULT_EXPENSE_ACCOUNTING_ACCOUNTS.bank,
    chargeByCategory: { ...DEFAULT_EXPENSE_ACCOUNTING_ACCOUNTS.chargeByCategory, ...(overrides?.chargeByCategory ?? {}) },
  };
}

function appValidation(field: string, message: string) {
  return { code: 'VALIDATION' as const, field, message };
}

export interface BuildExpenseAccountingEntryInput {
  entryId: string;
  expense: Expense;
  chart?: ChartOfAccounts;
  accounts?: Partial<ExpenseAccountingAccounts>;
}

/**
 * Écriture d'ACHAT à l'enregistrement de la dépense :
 * débit 6xx (charge = TTC − TVA), débit 44566 (TVA déductible SI mentionnée — prudence
 * art. 242 nonies A : pas de déduction sans TVA sur la pièce), crédit 401 (TTC).
 * La charge est dérivée de TTC − TVA (jamais du HT saisi) : l'équilibre est garanti par
 * construction, y compris quand l'OCR n'a pas lu le HT.
 */
export function buildRecordedExpenseAccountingEntry(
  input: BuildExpenseAccountingEntryInput,
): DomainResult<AccountingEntry> {
  const p = input.expense.toProps();
  if (p.totalTtcCents <= 0) return err(appValidation('expense.totalTtcCents', 'Montant TTC requis pour comptabiliser.'));

  const accounts = mergeAccounts(input.accounts);
  const vat = p.vatCents ?? 0;
  const charge = p.totalTtcCents - vat;
  const label = `Achat ${p.supplierName}`;

  const lines: AccountingEntryLineProps[] = [];
  if (charge > 0) lines.push({ account: accounts.chargeByCategory[p.category], label, debitCents: charge, creditCents: 0 });
  if (vat > 0) lines.push({ account: accounts.vatDeductible, label, debitCents: vat, creditCents: 0 });
  lines.push({ account: accounts.supplier, label, debitCents: 0, creditCents: p.totalTtcCents });

  return AccountingEntry.create(
    {
      id: input.entryId,
      companyId: p.companyId,
      journal: 'purchases',
      sourceType: 'expense',
      sourceId: p.id,
      entryDate: p.documentDate,
      reference: p.supplierName,
      label,
      lines,
    },
    input.chart ? { chart: input.chart } : {},
  );
}

export interface BuildExpensePaymentAccountingEntryInput {
  entryId: string;
  expense: Expense;
  /** Date de règlement — à défaut, la date de la pièce (dépense enregistrée déjà payée). */
  paidOn?: DateOnly;
  chart?: ChartOfAccounts;
  accounts?: Partial<ExpenseAccountingAccounts>;
}

/**
 * Écriture de DÉCAISSEMENT fournisseur (journal BQ) : débit 401 (apurement), crédit 512.
 * Sans elle, le 401 resterait perpétuellement créditeur et le rapprochement bancaire
 * serait impossible — le miroir exact de l'encaissement client (512/411).
 */
export function buildExpensePaymentAccountingEntry(
  input: BuildExpensePaymentAccountingEntryInput,
): DomainResult<AccountingEntry> {
  const p = input.expense.toProps();
  if (p.totalTtcCents <= 0) return err(appValidation('expense.totalTtcCents', 'Montant TTC requis pour comptabiliser.'));
  if (p.status !== 'paid') return err(appValidation('expense.status', 'La dépense doit être payée pour poster le règlement.'));

  const accounts = mergeAccounts(input.accounts);
  const label = `Règlement ${p.supplierName}`;

  return AccountingEntry.create(
    {
      id: input.entryId,
      companyId: p.companyId,
      journal: 'bank',
      sourceType: 'expense',
      sourceId: p.id,
      entryDate: input.paidOn ?? p.documentDate,
      reference: p.supplierName,
      label,
      lines: [
        { account: accounts.supplier, label, debitCents: p.totalTtcCents, creditCents: 0 },
        { account: accounts.bank, label, debitCents: 0, creditCents: p.totalTtcCents },
      ],
    },
    input.chart ? { chart: input.chart } : {},
  );
}
