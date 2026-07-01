import { type DomainResult, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type LineCategory } from '../billing/shared/line-item';
import { type Invoice } from '../billing/invoice/invoice';
import { AccountingEntry, type AccountingEntryLineProps, type AccountingEntryProps } from './accounting-entry';
import { type ChartOfAccounts } from './chart-of-accounts';

export type InvoiceRevenueAccountMap = Record<LineCategory, string>;

export interface InvoiceAccountingAccounts {
  receivable: string;
  vatCollected: string;
  customerAdvances: string;
  revenueByCategory: InvoiceRevenueAccountMap;
}

export const DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS: InvoiceAccountingAccounts = {
  receivable: '411',
  vatCollected: '44571',
  customerAdvances: '4191',
  revenueByCategory: {
    labor: '706',
    supply: '707',
    travel: '706',
    subscription: '706',
    disbursement: '467',
  },
};

export interface BuildInvoiceAccountingEntryInput {
  entryId: string;
  invoice: Invoice;
  chart?: ChartOfAccounts;
  accounts?: Partial<InvoiceAccountingAccounts>;
}

export interface BuildInvoiceAccountingPreviewEntryInput {
  entryId: string;
  invoice: Invoice;
  entryDate: DateOnly;
  reference?: string;
  chart?: ChartOfAccounts;
  accounts?: Partial<InvoiceAccountingAccounts>;
}

function appValidation(field: string, message: string) {
  return { code: 'VALIDATION' as const, field, message };
}

function mergeAccounts(overrides: Partial<InvoiceAccountingAccounts> | undefined): InvoiceAccountingAccounts {
  return {
    receivable: overrides?.receivable ?? DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS.receivable,
    vatCollected: overrides?.vatCollected ?? DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS.vatCollected,
    customerAdvances: overrides?.customerAdvances ?? DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS.customerAdvances,
    revenueByCategory: { ...DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS.revenueByCategory, ...(overrides?.revenueByCategory ?? {}) },
  };
}

function addAmount(bucket: Map<string, number>, account: string, amount: number): void {
  if (amount === 0) return;
  bucket.set(account, (bucket.get(account) ?? 0) + amount);
}

function allocateAmounts(fullAmounts: number[], targetTotal: number): number[] {
  const fullTotal = fullAmounts.reduce((sum, amount) => sum + amount, 0);
  if (fullTotal <= 0 || targetTotal <= 0) return fullAmounts.map(() => 0);
  const raw = fullAmounts.map((amount, index) => {
    const exact = (amount * targetTotal) / fullTotal;
    const floor = Math.floor(exact);
    return { index, floor, remainder: exact - floor };
  });
  let remaining = targetTotal - raw.reduce((sum, item) => sum + item.floor, 0);
  for (const item of [...raw].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.floor += 1;
    remaining -= 1;
  }
  return raw.sort((a, b) => a.index - b.index).map((item) => item.floor);
}

function lineBaseCents(line: Invoice['lines'][number]): number {
  return Math.round(line.qty * line.unitPriceHT);
}

function entryLinesFromSides(debits: Map<string, number>, credits: Map<string, number>, label: string): AccountingEntryLineProps[] {
  const lines: AccountingEntryLineProps[] = [];
  for (const [account, amount] of debits) lines.push({ account, label, debitCents: amount, creditCents: 0 });
  for (const [account, amount] of credits) lines.push({ account, label, debitCents: 0, creditCents: amount });
  return lines;
}

function buildInvoiceAccountingEntry(input: {
  entryId: string;
  invoice: Invoice;
  entryDate: DateOnly;
  reference: string;
  chart?: ChartOfAccounts;
  accounts?: Partial<InvoiceAccountingAccounts>;
}): DomainResult<AccountingEntry> {
  const invoice = input.invoice;
  const totals = invoice.totals();
  if (!Number.isSafeInteger(totals.netToPay) || totals.netToPay <= 0)
    return err(appValidation('invoice.netToPay', 'Net a payer invalide.'));

  const accounts = mergeAccounts(input.accounts);
  const fullComponents: { account: string; amount: number; kind: 'base' | 'vat' }[] = [];

  if (invoice.kind === 'deposit') {
    fullComponents.push({ account: accounts.customerAdvances, amount: totals.ht, kind: 'base' });
  } else {
    for (const line of invoice.lines) {
      fullComponents.push({
        account: accounts.revenueByCategory[line.category],
        amount: lineBaseCents(line),
        kind: 'base',
      });
    }
  }
  for (const vat of Object.values(totals.vatByRate)) {
    fullComponents.push({ account: accounts.vatCollected, amount: vat, kind: 'vat' });
  }

  const allocated = invoice.kind === 'deposit'
    ? allocateAmounts(fullComponents.map((component) => component.amount), totals.netToPay)
    : fullComponents.map((component) => component.amount);

  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  const isCreditNote = invoice.kind === 'credit_note';
  const label = `Facture ${input.reference}`;

  if (isCreditNote) addAmount(credit, accounts.receivable, totals.netToPay);
  else addAmount(debit, accounts.receivable, totals.netToPay);

  for (const [index, component] of fullComponents.entries()) {
    const amount = allocated[index] ?? 0;
    if (isCreditNote) addAmount(debit, component.account, amount);
    else addAmount(credit, component.account, amount);
  }

  const props: AccountingEntryProps = {
    id: input.entryId,
    companyId: invoice.companyId,
    journal: 'sales',
    sourceType: 'invoice',
    sourceId: invoice.id,
    entryDate: input.entryDate,
    reference: input.reference,
    label,
    lines: entryLinesFromSides(debit, credit, label),
  };
  return AccountingEntry.create(props, input.chart ? { chart: input.chart } : {});
}

/**
 * Produit l'ecriture comptable d'une facture emise, sans effet de bord.
 *
 * - Facture finale/situation : 411 debit ; 70x + 44571 credit.
 * - Facture d'acompte : 411 debit ; 4191 avances clients + 44571 credit.
 * - Avoir : ecriture inverse.
 *
 * Pour les acomptes, l'ecriture porte seulement sur `netToPay` : HT/TVA sont alloues au prorata
 * des composants de la facture, afin de ne pas comptabiliser 100% du CA sur un appel de 30%.
 */
export function buildIssuedInvoiceAccountingEntry(input: BuildInvoiceAccountingEntryInput): DomainResult<AccountingEntry> {
  const invoice = input.invoice;
  if (!['issued', 'partially_paid', 'late', 'paid'].includes(invoice.status))
    return err(appValidation('invoice', 'La facture doit etre emise avant comptabilisation.'));
  if (!invoice.number) return err(appValidation('invoice.number', 'Numero de facture requis.'));
  if (!invoice.issuedAt) return err(appValidation('invoice.issuedAt', "Date d'emission requise."));

  return buildInvoiceAccountingEntry({
    entryId: input.entryId,
    invoice,
    entryDate: invoice.issuedAt,
    reference: invoice.number,
    ...(input.chart ? { chart: input.chart } : {}),
    ...(input.accounts ? { accounts: input.accounts } : {}),
  });
}

/**
 * Aperçu prospectif de l'ecriture comptable d'une facture.
 *
 * Contrairement au mapper d'ecriture definitive, celui-ci n'exige pas que la facture soit emise :
 * il sert l'ActionDiff avant confirmation d'emission, sans allouer de numero et sans effet de bord.
 */
export function buildInvoiceAccountingPreviewEntry(input: BuildInvoiceAccountingPreviewEntryInput): DomainResult<AccountingEntry> {
  const reference = input.invoice.number ?? input.reference?.trim() ?? 'a-emettre';
  const entryDate = input.invoice.issuedAt ?? input.entryDate;
  return buildInvoiceAccountingEntry({
    entryId: input.entryId,
    invoice: input.invoice,
    entryDate,
    reference,
    ...(input.chart ? { chart: input.chart } : {}),
    ...(input.accounts ? { accounts: input.accounts } : {}),
  });
}
