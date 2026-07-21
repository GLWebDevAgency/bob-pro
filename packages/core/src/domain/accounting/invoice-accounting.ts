import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type LineCategory } from '../billing/shared/line-item';
import { type Invoice } from '../billing/invoice/invoice';
import { computeLineBases } from '../services/compute-totals';
import { AccountingEntry, type AccountingEntryLineProps, type AccountingEntryProps } from './accounting-entry';
import { type ChartOfAccounts } from './chart-of-accounts';

export type InvoiceRevenueAccountMap = Record<LineCategory, string>;

export interface InvoiceAccountingAccounts {
  receivable: string;
  vatCollected: string;
  customerAdvances: string;
  /** B5 — clients, retenues de garantie (PCG 4117) : créance différée jusqu'à réception + 1 an. */
  receivableRetention: string;
  revenueByCategory: InvoiceRevenueAccountMap;
}

export const DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS: InvoiceAccountingAccounts = {
  receivable: '411',
  vatCollected: '44571',
  customerAdvances: '4191',
  receivableRetention: '4117',
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
    receivableRetention: overrides?.receivableRetention ?? DEFAULT_INVOICE_ACCOUNTING_ACCOUNTS.receivableRetention,
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

/**
 * B3 — bases HT NETTES par ligne (remises de ligne + quote-part de remise globale déduites,
 * même politique d'allocation que computeTotals) : le CA crédité au 70x est le CA réellement
 * facturé — sans quoi l'écriture serait déséquilibrée du montant de la remise.
 */
function effectiveLineBases(invoice: Invoice): number[] {
  return computeLineBases(invoice.lines, { globalDiscount: invoice.globalDiscount }).netLineBases;
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
}): DomainResult<AccountingEntry | null> {
  const invoice = input.invoice;
  const totals = invoice.totals();
  const isCreditNote = invoice.kind === 'credit_note';
  const creditedKind = isCreditNote ? (invoice.creditNoteSource?.kind ?? null) : null;
  if (isCreditNote && creditedKind === null)
    return err(appValidation('invoice.sourceInvoiceId', 'La facture source de l’avoir est requise.'));
  const accountingKind = creditedKind ?? invoice.kind;
  // B2 — part de la deduction de la finale provenant des SITUATIONS emises : leur CA a DEJA ete
  // constate a chaque situation (70x). La finale ne re-credite que le CA restant, et la reprise
  // miroir 4191 ne porte que sur la part ACOMPTE (jamais un CA compte deux fois).
  const situationDeductionCents =
    accountingKind === 'final' && invoice.settlementSemanticsVersion === 1
      ? invoice.situationDeductionCents
      : 0;
  // Reprise d'avances : une finale deduit l'acompte deja facture (4191). Elle peut etre
  // entierement couverte (acompte + situations = 100 %) : netToPay = 0 y est legitime —
  // c'est precisement l'ecriture qui constate le CA (70x) et solde les avances.
  const advanceRepriseCents =
    accountingKind === 'final' ? invoice.advanceDeductionCents : 0;
  // B5 — retenue de garantie (loi 71-584) : creance client DIFFEREE (4117), figee aux totaux.
  const retentionCents = totals.retenueGarantieCents ?? 0;
  if (
    !Number.isSafeInteger(totals.netToPay) ||
    totals.netToPay < 0 ||
    (totals.netToPay === 0 && advanceRepriseCents === 0 && situationDeductionCents === 0 && retentionCents === 0)
  )
    return err(appValidation('invoice.netToPay', 'Net a payer invalide.'));

  const accounts = mergeAccounts(input.accounts);
  const fullComponents: { account: string; amount: number; kind: 'base' | 'vat' }[] = [];

  if (accountingKind === 'deposit') {
    fullComponents.push({ account: accounts.customerAdvances, amount: totals.ht, kind: 'base' });
  } else {
    // B3 — bases NETTES apres remises : le 70x porte le CA reellement facture.
    const bases = effectiveLineBases(invoice);
    for (const [index, line] of invoice.lines.entries()) {
      fullComponents.push({
        account: accounts.revenueByCategory[line.category],
        amount: bases[index] ?? 0,
        kind: 'base',
      });
    }
  }
  for (const vat of Object.values(totals.vatByRate)) {
    fullComponents.push({ account: accounts.vatCollected, amount: vat, kind: 'vat' });
  }

  // Acompte historique V1 : composants alloués au prorata du net à payer. Finale historique
  // V1 après situations : composants alloués au reliquat. En V2, acompte et finale portent déjà
  // leurs lignes fiscales réelles/résiduelles : toute nouvelle réduction serait un double retrait.
  const allocated = accountingKind === 'deposit'
    ? allocateAmounts(fullComponents.map((component) => component.amount), totals.netToPay)
    : situationDeductionCents > 0
      ? allocateAmounts(
          fullComponents.map((component) => component.amount),
          Math.max(0, totals.ttc - situationDeductionCents),
        )
      : fullComponents.map((component) => component.amount);

  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  // E7 : un avoir se lit « Avoir A-… » au journal — jamais « Facture » (libellé probant).
  const label = `${invoice.kind === 'credit_note' ? 'Avoir' : 'Facture'} ${input.reference}`;

  if (isCreditNote) addAmount(credit, accounts.receivable, totals.netToPay);
  else addAmount(debit, accounts.receivable, totals.netToPay);

  // B5 — la retenue est une creance client differee : 4117 au debit (au credit pour l'avoir),
  // en complement du 411 — le CA et la TVA restent constates PLEINS sur la piece.
  if (retentionCents > 0) {
    if (isCreditNote) addAmount(credit, accounts.receivableRetention, retentionCents);
    else addAmount(debit, accounts.receivableRetention, retentionCents);
  }

  for (const [index, component] of fullComponents.entries()) {
    const amount = allocated[index] ?? 0;
    if (isCreditNote) addAmount(debit, component.account, amount);
    else addAmount(credit, component.account, amount);
  }

  if (advanceRepriseCents > 0) {
    // Finale apres acompte : le 411 ne porte que le solde (netToPay = ttc − acompte), le CA
    // et la TVA sont credites PLEINS — sans reprise, l'ecriture serait desequilibree du
    // montant de l'acompte et rejetee. Schema PCG : D 4191 (part HT des avances) +
    // D 44571 (part TVA d'acompte) en MIROIR de l'ecriture d'acompte — memes composants
    // [HT, TVA par taux] et meme allocateAmounts, donc solde 4191 = 0 au centime,
    // multi-taux inclus, et la reprise reste lisible au journal (trace d'audit).
    const vatAmounts = Object.values(totals.vatByRate);
    const reprise = allocateAmounts([totals.ht, ...vatAmounts], advanceRepriseCents);
    addAmount(isCreditNote ? credit : debit, accounts.customerAdvances, reprise[0] ?? 0);
    for (let i = 0; i < vatAmounts.length; i += 1)
      addAmount(isCreditNote ? credit : debit, accounts.vatCollected, reprise[i + 1] ?? 0);
  }

  const entryLines = entryLinesFromSides(debit, credit, label);
  // B2 — finale (ou son avoir miroir) SOLDÉE PAR LES SITUATIONS SEULES : netToPay = 0, aucune
  // reprise 4191 (pas d'acompte), aucune retenue → TOUT le CA et TOUTE la TVA ont déjà été
  // constatés situation par situation (70x/44571 à chaque émission). Il n'existe AUCUN fait
  // comptable à enregistrer : l'écriture est LÉGITIMEMENT vide (null), et l'émission du solde
  // ne doit jamais échouer pour une écriture qui n'a pas lieu d'exister — la garde de cumul de
  // GenerateInvoiceFromQuote autorise explicitement situations = 100 % du marché, et le cas
  // symétrique « acompte 100 % » passe, lui, par la reprise 4191 (écriture non vide).
  if (
    entryLines.length === 0 &&
    accountingKind === 'final' &&
    situationDeductionCents > 0 &&
    totals.netToPay === 0 &&
    advanceRepriseCents === 0 &&
    retentionCents === 0
  )
    return ok(null);
  const props: AccountingEntryProps = {
    id: input.entryId,
    companyId: invoice.companyId,
    journal: 'sales',
    sourceType: 'invoice',
    sourceId: invoice.id,
    entryDate: input.entryDate,
    reference: input.reference,
    label,
    lines: entryLines,
  };
  return AccountingEntry.create(props, input.chart ? { chart: input.chart } : {});
}

/**
 * Produit l'ecriture comptable d'une facture emise, sans effet de bord.
 *
 * - Facture finale/situation : 411 debit ; 70x + 44571 credit.
 * - Facture d'acompte : 411 debit ; 4191 avances clients + 44571 credit.
 * - Finale APRES acompte : 411 debit (solde) + 4191/44571 debit (reprise des avances,
 *   miroir de l'ecriture d'acompte) ; 70x + 44571 credit PLEINS — le CA se constate a la
 *   finale, une seule fois, et le 4191 ressort a zero.
 * - Avoir : ecriture inverse.
 *
 * Pour les acomptes, l'ecriture porte seulement sur `netToPay` : HT/TVA sont alloues au prorata
 * des composants de la facture, afin de ne pas comptabiliser 100% du CA sur un appel de 30%.
 *
 * Retourne `ok(null)` — AUCUNE ecriture a poster — pour la facture FINALE de solde entierement
 * couverte par des SITUATIONS seules (B2) : son CA et sa TVA ont deja ete constates a chaque
 * situation, il n'existe aucun fait comptable (l'emission ne doit pas echouer pour autant).
 */
export function buildIssuedInvoiceAccountingEntry(input: BuildInvoiceAccountingEntryInput): DomainResult<AccountingEntry | null> {
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
 * `ok(null)` = aucune ecriture a passer (finale soldee par les situations seules, cf. ci-dessus).
 */
export function buildInvoiceAccountingPreviewEntry(input: BuildInvoiceAccountingPreviewEntryInput): DomainResult<AccountingEntry | null> {
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
