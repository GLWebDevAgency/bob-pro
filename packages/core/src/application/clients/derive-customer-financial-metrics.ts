import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { type Result, err, ok } from '../../shared-kernel/result';
import { isValidDateOnly, type DateOnly, type Instant } from '../../shared-kernel/time';

/**
 * Nombre minimal de factures soldées nécessaire avant d'afficher un comportement de paiement.
 * Une ou deux observations restent visibles via `settledInvoiceCount`, mais ne constituent pas
 * un historique représentatif. Ce seuil est une politique produit explicite, pas une règle légale.
 */
export const MIN_SETTLED_INVOICES_FOR_PAYMENT_METRICS = 3;

export interface CustomerFinancialMetricInvoiceData {
  id: string;
  companyId: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  totals: { netToPay: number };
  /** Centimes encaissés cumulés par l'agrégat facture. */
  paid: number;
  issuedAt: DateOnly | null;
  dueAt: DateOnly | null;
  /** Facture exacte annulée par cet avoir total. */
  sourceInvoiceId?: string | null;
}

export interface CustomerFinancialMetricPaymentData {
  id: string;
  companyId: string;
  invoiceId: string;
  amount: number;
  receivedAt: Instant;
}

export interface DeriveCustomerFinancialMetricsInput {
  companyId: string;
  customerId: string;
  /**
   * Les tableaux peuvent être company-wide : le moteur applique lui-même la clôture
   * `(companyId, customerId)` et ignore toute donnée d'un autre tenant/client.
   */
  invoices: readonly CustomerFinancialMetricInvoiceData[];
  payments: readonly CustomerFinancialMetricPaymentData[];
}

export type PaymentHistoryStatus = 'known' | 'insufficient_history' | 'incomplete';

export interface CustomerFinancialMetrics {
  companyId: string;
  customerId: string;
  /** Créances positives avant imputation des avoirs, en centimes. */
  grossReceivableCents: number;
  /** Avoirs encore imputables, en centimes positifs. */
  issuedCreditCents: number;
  /** Reste réellement dû par le client, jamais négatif. */
  outstandingCents: number;
  /** Excédent d'avoirs dû au client, séparé du reste dû pour ne jamais masquer un passif. */
  customerCreditCents: number;
  /**
   * Délai moyen facture → encaissement, pondéré par le montant des factures intégralement soldées,
   * en jours calendaires. `null` tant que l'historique n'est pas suffisant ou que la chaîne
   * Payment ↔ Invoice est incomplète.
   */
  avgDelayDays: number | null;
  /** Ratio de factures soldées au plus tard à l'échéance ; même disponibilité que avgDelayDays. */
  paidOnTimeRatio: number | null;
  paymentHistoryStatus: PaymentHistoryStatus;
  /** Factures soldées et rapprochées de leurs paiements, avant application du seuil minimum. */
  settledInvoiceCount: number;
  /** Un score sans modèle ratifié serait une donnée synthétique : il reste donc absent. */
  score: null;
  scoreStatus: 'model_not_ratified';
}

export type CustomerFinancialMetricsError =
  | { code: 'INVALID_SCOPE'; field: 'companyId' | 'customerId' }
  | { code: 'DUPLICATE_INVOICE'; invoiceId: string }
  | { code: 'DUPLICATE_PAYMENT'; paymentId: string }
  | {
      code: 'INVALID_INVOICE';
      invoiceId: string;
      field: 'id' | 'netToPay' | 'paid' | 'issuedAt' | 'dueAt' | 'sourceInvoiceId';
    }
  | { code: 'INVALID_PAYMENT'; paymentId: string; field: 'id' | 'amount' | 'receivedAt' }
  | { code: 'AGGREGATE_OVERFLOW'; field: 'receivables' | 'payments'; entityId: string };

const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);
const EFFECTIVE_CREDIT: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'paid', 'late']);
const MS_PER_DAY = 86_400_000;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyId(value: string): boolean {
  return value.trim().length > 0;
}

function isNonNegativeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function instantEpoch(value: Instant): number | null {
  if (!ISO_INSTANT.test(value) || !isValidDateOnly(value.slice(0, 10))) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function safeSum(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

function calendarDayFromEpoch(epoch: number): number {
  const date = new Date(epoch);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY;
}

function dateOnlyDay(value: DateOnly): number {
  return Date.parse(`${value}T00:00:00.000Z`) / MS_PER_DAY;
}

function validateInvoice(
  invoice: CustomerFinancialMetricInvoiceData,
): CustomerFinancialMetricsError | null {
  if (!isNonEmptyId(invoice.id)) return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'id' };
  if (!isNonNegativeCents(invoice.totals.netToPay))
    return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'netToPay' };
  if (!isNonNegativeCents(invoice.paid) || invoice.paid > invoice.totals.netToPay)
    return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'paid' };
  if (invoice.issuedAt !== null && !isValidDateOnly(invoice.issuedAt))
    return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'issuedAt' };
  if (invoice.dueAt !== null && !isValidDateOnly(invoice.dueAt))
    return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'dueAt' };
  if (invoice.issuedAt !== null && invoice.dueAt !== null && invoice.dueAt < invoice.issuedAt)
    return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'dueAt' };
  if (invoice.sourceInvoiceId !== undefined && invoice.sourceInvoiceId !== null) {
    if (!isNonEmptyId(invoice.sourceInvoiceId) || invoice.sourceInvoiceId === invoice.id)
      return { code: 'INVALID_INVOICE', invoiceId: invoice.id, field: 'sourceInvoiceId' };
  }
  return null;
}

function validatePayment(
  payment: CustomerFinancialMetricPaymentData,
): CustomerFinancialMetricsError | null {
  if (!isNonEmptyId(payment.id)) return { code: 'INVALID_PAYMENT', paymentId: payment.id, field: 'id' };
  if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0)
    return { code: 'INVALID_PAYMENT', paymentId: payment.id, field: 'amount' };
  if (instantEpoch(payment.receivedAt) === null)
    return { code: 'INVALID_PAYMENT', paymentId: payment.id, field: 'receivedAt' };
  return null;
}

interface SettledObservation {
  amountCents: number;
  collectionDays: number;
  paidOnTime: boolean;
}

/**
 * Dérive les métriques financières d'UN client depuis les factures et paiements persistés.
 *
 * Invariants :
 * - encours = `netToPay - paid` des statuts issued/partially_paid/late ;
 * - les avoirs sont signés négativement et un excédent devient `customerCreditCents` ;
 * - une finale porte déjà sa déduction d'acompte dans `netToPay`, donc acompte + finale sont
 *   additionnés tels quels, sans retraitement ni double compte ;
 * - le délai d'une facture court de son émission au règlement qui atteint le solde intégral ;
 * - les factures totalement avoirisées sont exclues du comportement de paiement ;
 * - aucune donnée étrangère au couple `(companyId, customerId)` ne peut influencer le résultat.
 */
export function deriveCustomerFinancialMetrics(
  input: DeriveCustomerFinancialMetricsInput,
): Result<CustomerFinancialMetrics, CustomerFinancialMetricsError> {
  if (!isNonEmptyId(input.companyId)) return err({ code: 'INVALID_SCOPE', field: 'companyId' });
  if (!isNonEmptyId(input.customerId)) return err({ code: 'INVALID_SCOPE', field: 'customerId' });

  const invoices = input.invoices.filter(
    (invoice) => invoice.companyId === input.companyId && invoice.customerId === input.customerId,
  );
  const invoiceIds = new Set<string>();
  for (const invoice of invoices) {
    const invalid = validateInvoice(invoice);
    if (invalid) return err(invalid);
    if (invoiceIds.has(invoice.id)) return err({ code: 'DUPLICATE_INVOICE', invoiceId: invoice.id });
    invoiceIds.add(invoice.id);
  }

  const payments = input.payments.filter(
    (payment) => payment.companyId === input.companyId && invoiceIds.has(payment.invoiceId),
  );
  const paymentIds = new Set<string>();
  const paymentsByInvoice = new Map<string, CustomerFinancialMetricPaymentData[]>();
  for (const payment of payments) {
    const invalid = validatePayment(payment);
    if (invalid) return err(invalid);
    if (paymentIds.has(payment.id)) return err({ code: 'DUPLICATE_PAYMENT', paymentId: payment.id });
    paymentIds.add(payment.id);
    const list = paymentsByInvoice.get(payment.invoiceId);
    if (list) list.push(payment);
    else paymentsByInvoice.set(payment.invoiceId, [payment]);
  }

  let grossReceivableCents = 0;
  let issuedCreditCents = 0;
  const effectiveCreditSourceIds = new Set<string>();

  for (const invoice of invoices) {
    if (invoice.kind === 'credit_note' && EFFECTIVE_CREDIT.has(invoice.status) && invoice.sourceInvoiceId) {
      effectiveCreditSourceIds.add(invoice.sourceInvoiceId);
    }
    if (!COLLECTIBLE.has(invoice.status)) continue;
    const remaining = invoice.totals.netToPay - invoice.paid;
    if (invoice.kind === 'credit_note') {
      const next = safeSum(issuedCreditCents, remaining);
      if (next === null) return err({ code: 'AGGREGATE_OVERFLOW', field: 'receivables', entityId: invoice.id });
      issuedCreditCents = next;
    } else {
      const next = safeSum(grossReceivableCents, remaining);
      if (next === null) return err({ code: 'AGGREGATE_OVERFLOW', field: 'receivables', entityId: invoice.id });
      grossReceivableCents = next;
    }
  }

  const netReceivableCents = grossReceivableCents - issuedCreditCents;
  const outstandingCents = Math.max(0, netReceivableCents);
  const customerCreditCents = Math.max(0, -netReceivableCents);

  const observations: SettledObservation[] = [];
  let incompleteHistory = false;

  for (const invoice of invoices) {
    if (
      invoice.kind === 'credit_note' ||
      invoice.status !== 'paid' ||
      invoice.totals.netToPay === 0 ||
      effectiveCreditSourceIds.has(invoice.id)
    ) {
      continue;
    }

    if (invoice.issuedAt === null || invoice.dueAt === null || invoice.paid !== invoice.totals.netToPay) {
      incompleteHistory = true;
      continue;
    }

    const invoicePayments = [...(paymentsByInvoice.get(invoice.id) ?? [])].sort((left, right) => {
      const byDate = (instantEpoch(left.receivedAt) ?? 0) - (instantEpoch(right.receivedAt) ?? 0);
      return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
    });
    let paymentTotal = 0;
    for (const payment of invoicePayments) {
      const next = safeSum(paymentTotal, payment.amount);
      if (next === null)
        return err({ code: 'AGGREGATE_OVERFLOW', field: 'payments', entityId: invoice.id });
      paymentTotal = next;
    }
    if (paymentTotal !== invoice.paid || invoicePayments.length === 0) {
      incompleteHistory = true;
      continue;
    }

    let cumulative = 0;
    let settledAt: number | null = null;
    for (const payment of invoicePayments) {
      const next = safeSum(cumulative, payment.amount);
      if (next === null)
        return err({ code: 'AGGREGATE_OVERFLOW', field: 'payments', entityId: invoice.id });
      cumulative = next;
      if (cumulative >= invoice.totals.netToPay) {
        settledAt = instantEpoch(payment.receivedAt);
        break;
      }
    }
    if (settledAt === null) {
      incompleteHistory = true;
      continue;
    }

    const settledDay = calendarDayFromEpoch(settledAt);
    const issuedDay = dateOnlyDay(invoice.issuedAt);
    if (settledDay < issuedDay) {
      incompleteHistory = true;
      continue;
    }
    const collectionDays = settledDay - issuedDay;
    observations.push({
      amountCents: invoice.totals.netToPay,
      collectionDays,
      paidOnTime: settledDay <= dateOnlyDay(invoice.dueAt),
    });
  }

  let paymentHistoryStatus: PaymentHistoryStatus;
  let avgDelayDays: number | null = null;
  let paidOnTimeRatio: number | null = null;
  if (incompleteHistory) {
    paymentHistoryStatus = 'incomplete';
  } else if (observations.length < MIN_SETTLED_INVOICES_FOR_PAYMENT_METRICS) {
    paymentHistoryStatus = 'insufficient_history';
  } else {
    paymentHistoryStatus = 'known';
    const settledCents = observations.reduce((sum, observation) => sum + BigInt(observation.amountCents), 0n);
    const weightedDelay = observations.reduce(
      (sum, observation) => sum + BigInt(observation.amountCents) * BigInt(observation.collectionDays),
      0n,
    );
    // Arrondi exact à l'entier le plus proche sans conversion flottante/overflow intermédiaire.
    avgDelayDays = Number((weightedDelay + settledCents / 2n) / settledCents);
    paidOnTimeRatio =
      observations.filter((observation) => observation.paidOnTime).length / observations.length;
  }

  return ok({
    companyId: input.companyId,
    customerId: input.customerId,
    grossReceivableCents,
    issuedCreditCents,
    outstandingCents,
    customerCreditCents,
    avgDelayDays,
    paidOnTimeRatio,
    paymentHistoryStatus,
    settledInvoiceCount: observations.length,
    score: null,
    scoreStatus: 'model_not_ratified',
  });
}
