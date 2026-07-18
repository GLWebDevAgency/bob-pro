import type { Prisma } from '@prisma/client';
import type {
  ApplyStripeSubscriptionInput,
  CreateStripeCheckoutAttemptInput,
  StripeBillingRepository,
  StripeCheckoutAttempt,
  StripeSubscriptionInvoiceRecord,
  StripeSubscriptionInvoiceSnapshot,
  StripeWebhookClaim,
  StripeWebhookClaimInput,
} from '../../payments/stripe-billing-contract';
import type { PrismaService } from './prisma.service';

interface CheckoutRow {
  id: string;
  companyId: string;
  purpose: string;
  status: string;
  plan: string | null;
  invoiceId: string | null;
  expectedAmountCents: number | null;
  currency: string;
  stripeSessionId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

interface SubscriptionInvoiceRow {
  stripeInvoiceId: string;
  companyId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  currency: string;
  number: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  stripeLastEventId: string;
  createdAt: Date;
  updatedAt: Date;
}

const SUBSCRIPTION_INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'void', 'uncollectible']);

function subscriptionInvoiceFrom(row: SubscriptionInvoiceRow): StripeSubscriptionInvoiceRecord {
  if (!SUBSCRIPTION_INVOICE_STATUSES.has(row.status) || row.currency !== 'eur') {
    throw new Error('Ligne Stripe facture abonnement invalide en base.');
  }
  return {
    stripeInvoiceId: row.stripeInvoiceId,
    companyId: row.companyId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status as StripeSubscriptionInvoiceRecord['status'],
    currency: 'eur',
    number: row.number,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    amountPaidCents: row.amountPaidCents,
    amountDueCents: row.amountDueCents,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    issuedAt: row.issuedAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    hostedInvoiceUrl: row.hostedInvoiceUrl,
    invoicePdfUrl: row.invoicePdfUrl,
    stripeLastEventId: row.stripeLastEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function checkoutFrom(row: CheckoutRow): StripeCheckoutAttempt {
  if (
    (row.purpose !== 'subscription' && row.purpose !== 'invoice_payment') ||
    !['creating', 'open', 'completed', 'expired', 'failed'].includes(row.status) ||
    row.currency !== 'eur'
  ) {
    throw new Error('Ligne Stripe checkout invalide en base.');
  }
  return {
    id: row.id,
    companyId: row.companyId,
    purpose: row.purpose,
    status: row.status as StripeCheckoutAttempt['status'],
    plan: row.plan as StripeCheckoutAttempt['plan'],
    invoiceId: row.invoiceId,
    expectedAmountCents: row.expectedAmountCents,
    currency: 'eur',
    stripeSessionId: row.stripeSessionId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function one(rows: CheckoutRow[], operation: string): StripeCheckoutAttempt {
  const row = rows[0];
  if (!row) throw new Error(`Stripe checkout introuvable pendant ${operation}.`);
  return checkoutFrom(row);
}

/** PostgreSQL est l'unique autorité runtime : aucune implémentation mémoire n'est composée en live. */
export class PrismaStripeBillingRepository implements StripeBillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(): Prisma.TransactionClient | PrismaService {
    return this.prisma.client() as Prisma.TransactionClient | PrismaService;
  }

  async createCheckoutAttempt(input: CreateStripeCheckoutAttemptInput): Promise<StripeCheckoutAttempt> {
    const rows = await this.client().$queryRaw<CheckoutRow[]>`
      INSERT INTO stripe_checkout_attempts (
        id, "companyId", purpose, status, plan, "invoiceId", "expectedAmountCents", currency,
        "createdAt", "updatedAt"
      ) VALUES (
        ${input.id}, ${input.companyId}, ${input.purpose}::"StripeCheckoutPurpose",
        'creating'::"StripeCheckoutAttemptStatus", ${input.plan}::"SubscriptionPlan",
        ${input.invoiceId}, ${input.expectedAmountCents}, ${input.currency},
        ${new Date(input.now)}, ${new Date(input.now)}
      )
      RETURNING *
    `;
    return one(rows, 'create');
  }

  async attachCheckoutSession(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    now: string;
  }): Promise<StripeCheckoutAttempt> {
    const rows = await this.client().$queryRaw<CheckoutRow[]>`
      UPDATE stripe_checkout_attempts
         SET status = 'open'::"StripeCheckoutAttemptStatus",
             "stripeSessionId" = ${input.stripeSessionId},
             "stripeCustomerId" = COALESCE("stripeCustomerId", ${input.stripeCustomerId}),
             "stripeSubscriptionId" = COALESCE("stripeSubscriptionId", ${input.stripeSubscriptionId}),
             "updatedAt" = ${new Date(input.now)}
       WHERE id = ${input.attemptId}
         AND "companyId" = ${input.companyId}
         AND status IN ('creating', 'open')
         AND ("stripeSessionId" IS NULL OR "stripeSessionId" = ${input.stripeSessionId})
      RETURNING *
    `;
    return one(rows, 'attach');
  }

  async markCheckoutFailed(input: {
    companyId: string;
    attemptId: string;
    failureCode: string;
    now: string;
  }): Promise<void> {
    await this.client().$executeRaw`
      UPDATE stripe_checkout_attempts
         SET status = 'failed'::"StripeCheckoutAttemptStatus",
             "failureCode" = ${input.failureCode.slice(0, 160)},
             "updatedAt" = ${new Date(input.now)}
       WHERE id = ${input.attemptId}
         AND "companyId" = ${input.companyId}
         AND status IN ('creating', 'open', 'failed')
    `;
  }

  async lockCheckoutAttempt(companyId: string, attemptId: string): Promise<StripeCheckoutAttempt | null> {
    const rows = await this.client().$queryRaw<CheckoutRow[]>`
      SELECT * FROM stripe_checkout_attempts
       WHERE id = ${attemptId} AND "companyId" = ${companyId}
       FOR UPDATE
    `;
    return rows[0] ? checkoutFrom(rows[0]) : null;
  }

  async completeCheckoutAttempt(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripePaymentIntentId: string | null;
    now: string;
  }): Promise<void> {
    const count = await this.client().$executeRaw`
      UPDATE stripe_checkout_attempts
         SET status = 'completed'::"StripeCheckoutAttemptStatus",
             "stripeSessionId" = ${input.stripeSessionId},
             "stripeCustomerId" = COALESCE("stripeCustomerId", ${input.stripeCustomerId}),
             "stripeSubscriptionId" = COALESCE("stripeSubscriptionId", ${input.stripeSubscriptionId}),
             "stripePaymentIntentId" = COALESCE("stripePaymentIntentId", ${input.stripePaymentIntentId}),
             "failureCode" = NULL,
             "completedAt" = COALESCE("completedAt", ${new Date(input.now)}),
             "updatedAt" = ${new Date(input.now)}
       WHERE id = ${input.attemptId}
         AND "companyId" = ${input.companyId}
         AND status IN ('creating', 'open', 'completed')
         AND ("stripeSessionId" IS NULL OR "stripeSessionId" = ${input.stripeSessionId})
    `;
    if (count !== 1) throw new Error('Stripe checkout non complétable.');
  }

  async expireCheckoutAttempt(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    now: string;
  }): Promise<void> {
    const count = await this.client().$executeRaw`
      UPDATE stripe_checkout_attempts
         SET status = 'expired'::"StripeCheckoutAttemptStatus",
             "stripeSessionId" = ${input.stripeSessionId},
             "updatedAt" = ${new Date(input.now)}
       WHERE id = ${input.attemptId}
         AND "companyId" = ${input.companyId}
         AND status IN ('creating', 'open', 'expired')
         AND ("stripeSessionId" IS NULL OR "stripeSessionId" = ${input.stripeSessionId})
    `;
    if (count !== 1) throw new Error('Stripe checkout non expirable.');
  }

  async claimWebhook(input: StripeWebhookClaimInput): Promise<StripeWebhookClaim> {
    const inserted = await this.client().$queryRaw<Array<{ eventId: string }>>`
      INSERT INTO stripe_webhook_events (
        "eventId", "companyId", "eventType", status, "providerCreatedAt", "payloadSha256",
        livemode, "apiVersion", attempts, "processingStartedAt", "receivedAt", "updatedAt"
      ) VALUES (
        ${input.eventId}, ${input.companyId}, ${input.eventType},
        'processing'::"StripeWebhookEventStatus", ${new Date(input.providerCreatedAt)},
        ${input.payloadSha256}, ${input.livemode}, ${input.apiVersion}, 1,
        ${new Date(input.now)}, ${new Date(input.now)}, ${new Date(input.now)}
      )
      ON CONFLICT ("eventId") DO NOTHING
      RETURNING "eventId"
    `;
    if (inserted.length === 1) return 'claimed';

    const rows = await this.client().$queryRaw<Array<{
      companyId: string;
      payloadSha256: string;
      status: string;
      processingStartedAt: Date;
    }>>`
      SELECT "companyId", "payloadSha256", status, "processingStartedAt"
        FROM stripe_webhook_events
       WHERE "eventId" = ${input.eventId}
       FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new Error('Inbox Stripe introuvable après conflit.');
    if (current.companyId !== input.companyId || current.payloadSha256 !== input.payloadSha256) {
      throw new Error('STRIPE_EVENT_IDENTITY_MISMATCH');
    }
    if (current.status === 'processed') return 'already_processed';
    const stale = new Date(input.now).getTime() - current.processingStartedAt.getTime() >= 5 * 60_000;
    if (current.status === 'processing' && !stale) return 'already_processing';
    await this.client().$executeRaw`
      UPDATE stripe_webhook_events
         SET status = 'processing'::"StripeWebhookEventStatus",
             attempts = attempts + 1,
             "processingStartedAt" = ${new Date(input.now)},
             "failureCode" = NULL,
             "updatedAt" = ${new Date(input.now)}
       WHERE "eventId" = ${input.eventId} AND "companyId" = ${input.companyId}
    `;
    return 'claimed';
  }

  async markWebhookProcessed(input: { companyId: string; eventId: string; now: string }): Promise<void> {
    const count = await this.client().$executeRaw`
      UPDATE stripe_webhook_events
         SET status = 'processed'::"StripeWebhookEventStatus",
             "processedAt" = ${new Date(input.now)},
             "failureCode" = NULL,
             "updatedAt" = ${new Date(input.now)}
       WHERE "eventId" = ${input.eventId}
         AND "companyId" = ${input.companyId}
         AND status = 'processing'
    `;
    if (count !== 1) throw new Error('Inbox Stripe non finalisable.');
  }

  async markWebhookFailed(input: {
    companyId: string;
    eventId: string;
    failureCode: string;
    now: string;
  }): Promise<void> {
    await this.client().$executeRaw`
      UPDATE stripe_webhook_events
         SET status = 'failed'::"StripeWebhookEventStatus",
             "failureCode" = ${input.failureCode.slice(0, 160)},
             "updatedAt" = ${new Date(input.now)}
       WHERE "eventId" = ${input.eventId}
         AND "companyId" = ${input.companyId}
         AND status = 'processing'
    `;
  }

  async applySubscription(input: ApplyStripeSubscriptionInput): Promise<void> {
    const rows = await this.client().$queryRaw<Array<{ id: string }>>`
      UPDATE subscriptions
         SET plan = ${input.plan}::"SubscriptionPlan",
             status = ${input.status}::"SubscriptionStatus",
             "trialEndsAt" = ${input.trialEndsAt === null ? null : new Date(input.trialEndsAt)},
             "currentPeriodEnd" = ${
               input.currentPeriodEnd === null ? null : new Date(input.currentPeriodEnd)
             },
             store = 'stripe'::"SubscriptionStore",
             "storeRef" = ${input.stripeSubscriptionId},
             "stripeCustomerId" = ${input.stripeCustomerId},
             "stripeSubscriptionId" = ${input.stripeSubscriptionId},
             "stripeLastEventId" = ${input.eventId},
             "stripeLastSyncedAt" = ${new Date(input.now)},
             "updatedAt" = ${new Date(input.now)}
       WHERE "companyId" = ${input.companyId}
         AND ("stripeCustomerId" IS NULL OR "stripeCustomerId" = ${input.stripeCustomerId})
         AND ("stripeSubscriptionId" IS NULL OR "stripeSubscriptionId" = ${input.stripeSubscriptionId})
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error('STRIPE_SUBSCRIPTION_BINDING_MISMATCH');
  }

  async upsertSubscriptionInvoice(input: {
    companyId: string;
    eventId: string;
    snapshot: StripeSubscriptionInvoiceSnapshot;
    now: string;
  }): Promise<void> {
    const invoice = input.snapshot;
    const rows = await this.client().$queryRaw<Array<{ stripeInvoiceId: string }>>`
      INSERT INTO stripe_subscription_invoices (
        "stripeInvoiceId", "companyId", "stripeCustomerId", "stripeSubscriptionId",
        status, currency, number, "subtotalCents", "taxCents", "totalCents",
        "amountPaidCents", "amountDueCents", "periodStart", "periodEnd", "issuedAt",
        "paidAt", "hostedInvoiceUrl", "invoicePdfUrl", "stripeLastEventId", "createdAt", "updatedAt"
      ) VALUES (
        ${invoice.stripeInvoiceId}, ${input.companyId}, ${invoice.stripeCustomerId},
        ${invoice.stripeSubscriptionId},
        ${invoice.status}::"StripeSubscriptionInvoiceStatus", ${invoice.currency}, ${invoice.number},
        ${invoice.subtotalCents}, ${invoice.taxCents}, ${invoice.totalCents},
        ${invoice.amountPaidCents}, ${invoice.amountDueCents}, ${new Date(invoice.periodStart)},
        ${new Date(invoice.periodEnd)}, ${new Date(invoice.issuedAt)},
        ${invoice.paidAt === null ? null : new Date(invoice.paidAt)}, ${invoice.hostedInvoiceUrl},
        ${invoice.invoicePdfUrl}, ${input.eventId}, ${new Date(input.now)}, ${new Date(input.now)}
      )
      ON CONFLICT ("stripeInvoiceId") DO UPDATE SET
        status = EXCLUDED.status,
        number = EXCLUDED.number,
        "subtotalCents" = EXCLUDED."subtotalCents",
        "taxCents" = EXCLUDED."taxCents",
        "totalCents" = EXCLUDED."totalCents",
        "amountPaidCents" = EXCLUDED."amountPaidCents",
        "amountDueCents" = EXCLUDED."amountDueCents",
        "periodStart" = EXCLUDED."periodStart",
        "periodEnd" = EXCLUDED."periodEnd",
        "issuedAt" = EXCLUDED."issuedAt",
        "paidAt" = EXCLUDED."paidAt",
        "hostedInvoiceUrl" = EXCLUDED."hostedInvoiceUrl",
        "invoicePdfUrl" = EXCLUDED."invoicePdfUrl",
        "stripeLastEventId" = EXCLUDED."stripeLastEventId",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE stripe_subscription_invoices."companyId" = EXCLUDED."companyId"
        AND stripe_subscription_invoices."stripeCustomerId" = EXCLUDED."stripeCustomerId"
        AND stripe_subscription_invoices."stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId"
      RETURNING "stripeInvoiceId"
    `;
    if (rows.length !== 1) throw new Error('STRIPE_INVOICE_BINDING_MISMATCH');
  }

  async listSubscriptionInvoices(companyId: string): Promise<StripeSubscriptionInvoiceRecord[]> {
    const rows = await this.client().$queryRaw<SubscriptionInvoiceRow[]>`
      SELECT *
        FROM stripe_subscription_invoices
       WHERE "companyId" = ${companyId}
       ORDER BY "issuedAt" DESC, "stripeInvoiceId" DESC
       LIMIT 200
    `;
    return rows.map(subscriptionInvoiceFrom);
  }
}
