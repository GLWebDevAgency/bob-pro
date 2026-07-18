import type { PlanTier, SubscriptionStatus } from '@bob/core';

export type StripeCheckoutPurpose = 'subscription' | 'invoice_payment';
export type StripeCheckoutAttemptStatus =
  | 'creating'
  | 'open'
  | 'completed'
  | 'expired'
  | 'failed';

export interface StripeCheckoutAttempt {
  readonly id: string;
  readonly companyId: string;
  readonly purpose: StripeCheckoutPurpose;
  readonly status: StripeCheckoutAttemptStatus;
  readonly plan: PlanTier | null;
  readonly invoiceId: string | null;
  readonly expectedAmountCents: number | null;
  readonly currency: 'eur';
  readonly stripeSessionId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateStripeCheckoutAttemptInput {
  readonly id: string;
  readonly companyId: string;
  readonly purpose: StripeCheckoutPurpose;
  readonly plan: PlanTier | null;
  readonly invoiceId: string | null;
  readonly expectedAmountCents: number | null;
  readonly currency: 'eur';
  readonly now: string;
}

export type StripeWebhookClaim = 'claimed' | 'already_processed' | 'already_processing';

export interface StripeWebhookClaimInput {
  readonly eventId: string;
  readonly companyId: string;
  readonly eventType: string;
  readonly providerCreatedAt: string;
  readonly payloadSha256: string;
  readonly livemode: boolean;
  readonly apiVersion: string | null;
  readonly now: string;
}

export interface ApplyStripeSubscriptionInput {
  readonly companyId: string;
  readonly checkoutAttemptId: string | null;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly plan: Exclude<PlanTier, 'free'>;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly eventId: string;
  readonly now: string;
}

export type StripeSubscriptionInvoiceStatus =
  | 'draft'
  | 'open'
  | 'paid'
  | 'void'
  | 'uncollectible';

/** Projection fournisseur vérifiée puis persistée, sans payload Stripe brut ni donnée carte. */
export interface StripeSubscriptionInvoiceSnapshot {
  readonly stripeInvoiceId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly status: StripeSubscriptionInvoiceStatus;
  readonly currency: 'eur';
  readonly number: string | null;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly amountDueCents: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly issuedAt: string;
  readonly paidAt: string | null;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StripeSubscriptionInvoiceRecord
  extends Omit<StripeSubscriptionInvoiceSnapshot, 'metadata'> {
  readonly companyId: string;
  readonly stripeLastEventId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Port de persistance Stripe. Toutes les méthodes sont appelées dans un `runWithTenant` :
 * `companyId` reste néanmoins présent dans chaque prédicat de mutation pour que l'isolation ne
 * dépende jamais seulement du contexte applicatif.
 */
export interface StripeBillingRepository {
  createCheckoutAttempt(input: CreateStripeCheckoutAttemptInput): Promise<StripeCheckoutAttempt>;
  attachCheckoutSession(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    now: string;
  }): Promise<StripeCheckoutAttempt>;
  markCheckoutFailed(input: {
    companyId: string;
    attemptId: string;
    failureCode: string;
    now: string;
  }): Promise<void>;
  lockCheckoutAttempt(companyId: string, attemptId: string): Promise<StripeCheckoutAttempt | null>;
  completeCheckoutAttempt(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripePaymentIntentId: string | null;
    now: string;
  }): Promise<void>;
  expireCheckoutAttempt(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    now: string;
  }): Promise<void>;
  claimWebhook(input: StripeWebhookClaimInput): Promise<StripeWebhookClaim>;
  markWebhookProcessed(input: {
    companyId: string;
    eventId: string;
    now: string;
  }): Promise<void>;
  markWebhookFailed(input: {
    companyId: string;
    eventId: string;
    failureCode: string;
    now: string;
  }): Promise<void>;
  applySubscription(input: ApplyStripeSubscriptionInput): Promise<void>;
  upsertSubscriptionInvoice(input: {
    companyId: string;
    eventId: string;
    snapshot: StripeSubscriptionInvoiceSnapshot;
    now: string;
  }): Promise<void>;
  listSubscriptionInvoices(companyId: string): Promise<StripeSubscriptionInvoiceRecord[]>;
}

export interface VerifiedStripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly apiVersion: string | null;
  readonly dataObject: unknown;
}

export interface StripeCheckoutSessionSnapshot {
  readonly id: string;
  readonly mode: 'subscription' | 'payment' | 'setup' | null;
  readonly status: 'open' | 'complete' | 'expired' | null;
  readonly paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' | null;
  readonly amountTotal: number | null;
  readonly currency: string | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly paymentIntentId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StripeSubscriptionSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly priceIds: readonly string[];
  readonly currentPeriodEnd: string | null;
  readonly trialEndsAt: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StripeBillingProvider {
  readonly subscriptionBillingAvailable: boolean;
  readonly expectedLivemode: boolean;
  createSubscriptionCheckout(input: {
    companyId: string;
    checkoutAttemptId: string;
    tier: PlanTier;
    stripeCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }>;
  createInvoicePaymentLink(input: {
    companyId: string;
    checkoutAttemptId: string;
    invoiceId: string;
    amountCents: number;
    label: string;
  }): Promise<{ url: string; sessionId: string }>;
  createBillingPortal(input: { stripeCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedStripeWebhookEvent;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionSnapshot>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot>;
  retrieveSubscriptionInvoice(invoiceId: string): Promise<StripeSubscriptionInvoiceSnapshot>;
  tierForPriceIds(priceIds: readonly string[]): Exclude<PlanTier, 'free'> | null;
}
