import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type Invoice } from '../billing/invoice/invoice';
import { type Payment, type PaymentMethod } from '../payment/payment';
import { AccountingEntry, type AccountingEntryLineProps, type AccountingEntryProps } from './accounting-entry';
import { type ChartOfAccounts } from './chart-of-accounts';

export interface PaymentAccountingAccounts {
  receivable: string;
  bank: string;
  cash: string;
  cardClearing: string;
}

export const DEFAULT_PAYMENT_ACCOUNTING_ACCOUNTS: PaymentAccountingAccounts = {
  receivable: '411',
  bank: '512',
  cash: '530',
  cardClearing: '512',
};

export interface BuildPaymentAccountingEntryInput {
  entryId: string;
  payment: Payment;
  invoice: Invoice;
  chart?: ChartOfAccounts;
  accounts?: Partial<PaymentAccountingAccounts>;
}

export interface BuildPaymentAccountingPreviewLinesInput {
  amountCents: number;
  method?: PaymentMethod;
  reference?: string | null;
  accounts?: Partial<PaymentAccountingAccounts>;
}

function appValidation(field: string, message: string) {
  return { code: 'VALIDATION' as const, field, message };
}

function mergeAccounts(overrides: Partial<PaymentAccountingAccounts> | undefined): PaymentAccountingAccounts {
  return {
    receivable: overrides?.receivable ?? DEFAULT_PAYMENT_ACCOUNTING_ACCOUNTS.receivable,
    bank: overrides?.bank ?? DEFAULT_PAYMENT_ACCOUNTING_ACCOUNTS.bank,
    cash: overrides?.cash ?? DEFAULT_PAYMENT_ACCOUNTING_ACCOUNTS.cash,
    cardClearing: overrides?.cardClearing ?? DEFAULT_PAYMENT_ACCOUNTING_ACCOUNTS.cardClearing,
  };
}

function debitAccountFor(method: PaymentMethod, accounts: PaymentAccountingAccounts): string {
  if (method === 'cash') return accounts.cash;
  if (method === 'card') return accounts.cardClearing;
  return accounts.bank;
}

function dateOnlyFromInstant(instant: string): DateOnly {
  return instant.slice(0, 10) as DateOnly;
}

export function buildPaymentAccountingPreviewLines(input: BuildPaymentAccountingPreviewLinesInput): DomainResult<AccountingEntryLineProps[]> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
    return err(appValidation('amountCents', 'Montant > 0 requis en centimes entiers.'));

  const accounts = mergeAccounts(input.accounts);
  const reference = input.reference?.trim() || 'facture';
  const label = `Encaissement ${reference}`;
  const debitAccount = debitAccountFor(input.method ?? 'transfer', accounts);
  return ok([
    { account: debitAccount, label, debitCents: input.amountCents, creditCents: 0 },
    { account: accounts.receivable, label, debitCents: 0, creditCents: input.amountCents },
  ]);
}

/**
 * Produit l'ecriture comptable d'un encaissement client, sans effet de bord.
 *
 * - Virement/carte : 512 debit ; 411 credit.
 * - Especes : 530 debit ; 411 credit.
 *
 * Le paiement est la source comptable : l'id de l'ecriture doit donc etre derive du paiement,
 * pas de la facture, pour permettre plusieurs encaissements partiels sur une meme facture.
 */
export function buildPaymentAccountingEntry(input: BuildPaymentAccountingEntryInput): DomainResult<AccountingEntry> {
  const { payment, invoice } = input;
  if (payment.companyId !== invoice.companyId)
    return err(appValidation('payment.companyId', "Le paiement n'appartient pas a la societe de la facture."));
  if (payment.invoiceId !== invoice.id)
    return err(appValidation('payment.invoiceId', "Le paiement n'est pas rattache a cette facture."));

  const accounts = mergeAccounts(input.accounts);
  const reference = invoice.number ?? invoice.id;
  const lines = buildPaymentAccountingPreviewLines({
    amountCents: payment.amount,
    method: payment.method,
    reference,
    accounts,
  });
  if (!lines.ok) return lines;
  const label = lines.value[0]?.label ?? `Encaissement ${reference}`;
  const props: AccountingEntryProps = {
    id: input.entryId,
    companyId: payment.companyId,
    journal: 'bank',
    sourceType: 'payment',
    sourceId: payment.id,
    entryDate: dateOnlyFromInstant(payment.receivedAt),
    reference,
    label,
    lines: lines.value,
  };
  return AccountingEntry.create(props, input.chart ? { chart: input.chart } : {});
}
