import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RecordPaymentAccountingEntry,
  RegisterPayment,
  SystemClock,
  type AppError,
  type CheckoutResult,
  type ClockPort,
  type IdGeneratorPort,
  type PlanTier,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '@bob/core';
import { PERSISTENCE } from '../persistence/persistence-token';
import type { Persistence } from '../persistence/persistence';
import { UuidGenerator } from '../id-generator';
import { AppLogger } from '../observability/logger';
import { PAYMENT_GATEWAY } from './payment-gateway';
import type {
  StripeBillingProvider,
  StripeBillingRepository,
  StripeCheckoutAttempt,
  StripeCheckoutSessionSnapshot,
  StripeSubscriptionInvoiceSnapshot,
  StripeSubscriptionInvoiceRecord,
  StripeSubscriptionSnapshot,
  VerifiedStripeWebhookEvent,
} from './stripe-billing-contract';
import { locateStripeReconciliation, type StripeReconciliationLocator } from './stripe-event-parser';

type StripePersistence = Persistence & { readonly stripeBilling: StripeBillingRepository };

export interface StripeWebhookReceipt {
  readonly received: true;
  readonly eventId: string;
  readonly outcome: 'processed' | 'replayed' | 'ignored';
}

export class StripeReconciliationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'StripeReconciliationError';
  }
}

function reconciliationError(code: string, retryable = false): StripeReconciliationError {
  return new StripeReconciliationError(code, retryable);
}

function assertSame(actual: string | null, expected: string, code: string): void {
  if (actual !== expected) throw reconciliationError(code);
}

function eventInstant(event: VerifiedStripeWebhookEvent): string {
  if (!Number.isSafeInteger(event.created) || event.created < 0) {
    throw reconciliationError('STRIPE_EVENT_CREATED_INVALID');
  }
  return new Date(event.created * 1_000).toISOString();
}

function payloadSha256(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

function subscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    default:
      throw reconciliationError('STRIPE_SUBSCRIPTION_STATUS_UNSUPPORTED', true);
  }
}

function requireMetadata(
  metadata: Readonly<Record<string, string>>,
  key: string,
  expected: string,
): void {
  if (metadata[key] !== expected) throw reconciliationError(`STRIPE_METADATA_MISMATCH:${key}`);
}

function validateAttempt(
  attempt: StripeCheckoutAttempt | null,
  locator: Extract<StripeReconciliationLocator, { kind: 'checkout' }>,
): StripeCheckoutAttempt {
  if (!attempt) throw reconciliationError('STRIPE_CHECKOUT_ATTEMPT_NOT_FOUND', true);
  if (attempt.companyId !== locator.companyId || attempt.purpose !== locator.purpose) {
    throw reconciliationError('STRIPE_CHECKOUT_TENANT_MISMATCH');
  }
  if (attempt.stripeSessionId !== null && attempt.stripeSessionId !== locator.stripeSessionId) {
    throw reconciliationError('STRIPE_CHECKOUT_SESSION_MISMATCH');
  }
  return attempt;
}

function validateSubscriptionSnapshot(
  snapshot: StripeSubscriptionSnapshot,
  locator: Extract<StripeReconciliationLocator, { kind: 'subscription' }>,
): void {
  assertSame(snapshot.id, locator.stripeSubscriptionId, 'STRIPE_SUBSCRIPTION_ID_MISMATCH');
  requireMetadata(snapshot.metadata, 'bob_company_id', locator.companyId);
  if (locator.checkoutAttemptId !== null) {
    requireMetadata(snapshot.metadata, 'bob_checkout_id', locator.checkoutAttemptId);
  }
  requireMetadata(snapshot.metadata, 'bob_purpose', 'subscription');
}

function validateSubscriptionInvoiceSnapshot(
  snapshot: StripeSubscriptionInvoiceSnapshot,
  locator: Extract<StripeReconciliationLocator, { kind: 'subscription_invoice' }>,
): void {
  assertSame(snapshot.stripeInvoiceId, locator.stripeInvoiceId, 'STRIPE_INVOICE_ID_MISMATCH');
  assertSame(
    snapshot.stripeSubscriptionId,
    locator.stripeSubscriptionId,
    'STRIPE_INVOICE_SUBSCRIPTION_MISMATCH',
  );
  requireMetadata(snapshot.metadata, 'bob_company_id', locator.companyId);
  requireMetadata(snapshot.metadata, 'bob_purpose', 'subscription');
  if (locator.checkoutAttemptId !== null) {
    requireMetadata(snapshot.metadata, 'bob_checkout_id', locator.checkoutAttemptId);
  }
}

function providerFailureCode(error: unknown): string {
  if (error instanceof StripeReconciliationError) return error.code.slice(0, 160);
  if (error instanceof Error && error.name === 'StripeSignatureVerificationError') {
    return 'STRIPE_SIGNATURE_INVALID';
  }
  return 'STRIPE_RECONCILIATION_DEPENDENCY_FAILURE';
}

function stripeBindingOf(
  record: SubscriptionRecord,
): { customerId: string; subscriptionId: string } | null {
  const extended = record as SubscriptionRecord & {
    readonly stripeCustomerId?: unknown;
    readonly stripeSubscriptionId?: unknown;
  };
  const customerId = extended.stripeCustomerId;
  const subscriptionId = extended.stripeSubscriptionId;
  if (
    (customerId === undefined || customerId === null) &&
    (subscriptionId === undefined || subscriptionId === null)
  ) {
    return null;
  }
  if (
    typeof customerId !== 'string' ||
    !/^cus_[A-Za-z0-9]+$/u.test(customerId) ||
    typeof subscriptionId !== 'string' ||
    !/^sub_[A-Za-z0-9]+$/u.test(subscriptionId)
  ) {
    throw reconciliationError('STRIPE_BINDING_INVALID');
  }
  return { customerId, subscriptionId };
}

@Injectable()
export class StripeBillingService {
  private readonly ids: IdGeneratorPort;
  private readonly clock: ClockPort;

  constructor(
    @Inject(PERSISTENCE) private readonly persistence: StripePersistence,
    @Inject(PAYMENT_GATEWAY) private readonly provider: StripeBillingProvider,
    private readonly logger: AppLogger,
  ) {
    this.ids = new UuidGenerator();
    this.clock = new SystemClock();
  }

  get subscriptionBillingAvailable(): boolean {
    return this.provider.subscriptionBillingAvailable;
  }

  async listSubscriptionInvoices(companyId: string): Promise<StripeSubscriptionInvoiceRecord[]> {
    return this.persistence.runWithTenant(companyId, () =>
      this.persistence.stripeBilling.listSubscriptionInvoices(companyId),
    );
  }

  async startSubscriptionCheckout(input: {
    companyId: string;
    tier: PlanTier;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    if (!this.provider.subscriptionBillingAvailable) {
      throw reconciliationError('SUBSCRIPTION_BILLING_UNAVAILABLE');
    }
    if (input.tier === 'free') throw reconciliationError('STRIPE_FREE_PLAN_HAS_NO_CHECKOUT');
    const subscription = await this.persistence.runWithTenant(input.companyId, () =>
      this.persistence.subscriptions.findByCompanyId(input.companyId),
    );
    if (!subscription) throw reconciliationError('SUBSCRIPTION_PROVISIONING_REQUIRED', true);
    const attemptId = this.ids.newId();
    const now = this.clock.now();
    await this.persistence.runWithTenant(input.companyId, () =>
      this.persistence.stripeBilling.createCheckoutAttempt({
        id: attemptId,
        companyId: input.companyId,
        purpose: 'subscription',
        plan: input.tier,
        invoiceId: null,
        expectedAmountCents: null,
        currency: 'eur',
        now,
      }),
    );

    let checkout: CheckoutResult | null = null;
    try {
      checkout = await this.provider.createSubscriptionCheckout({
        companyId: input.companyId,
        checkoutAttemptId: attemptId,
        tier: input.tier,
        stripeCustomerId: stripeBindingOf(subscription)?.customerId ?? null,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      await this.persistence.runWithTenant(input.companyId, () =>
        this.persistence.stripeBilling.attachCheckoutSession({
          companyId: input.companyId,
          attemptId,
          stripeSessionId: checkout!.sessionId,
          stripeCustomerId: stripeBindingOf(subscription)?.customerId ?? null,
          stripeSubscriptionId: null,
          now: this.clock.now(),
        }),
      );
      return checkout;
    } catch (error) {
      if (checkout) await this.provider.expireCheckoutSession(checkout.sessionId).catch(() => undefined);
      await this.persistence
        .runWithTenant(input.companyId, () =>
          this.persistence.stripeBilling.markCheckoutFailed({
            companyId: input.companyId,
            attemptId,
            failureCode: providerFailureCode(error),
            now: this.clock.now(),
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async createBillingPortal(companyId: string, returnUrl: string): Promise<{ url: string }> {
    if (!this.provider.subscriptionBillingAvailable) {
      throw reconciliationError('SUBSCRIPTION_BILLING_UNAVAILABLE');
    }
    const subscription = await this.persistence.runWithTenant(companyId, () =>
      this.persistence.subscriptions.findByCompanyId(companyId),
    );
    const stripeCustomerId = subscription ? (stripeBindingOf(subscription)?.customerId ?? null) : null;
    if (!stripeCustomerId) throw reconciliationError('STRIPE_CUSTOMER_NOT_LINKED');
    return this.provider.createBillingPortal({ stripeCustomerId, returnUrl });
  }

  async createInvoicePaymentLink(input: {
    companyId: string;
    invoiceId: string;
    label: string;
  }): Promise<CheckoutResult> {
    if (!this.provider.subscriptionBillingAvailable) {
      throw reconciliationError('SUBSCRIPTION_BILLING_UNAVAILABLE');
    }
    const invoice = await this.persistence.runWithTenant(input.companyId, () =>
      this.persistence.invoices.findById(input.invoiceId),
    );
    if (!invoice || invoice.companyId !== input.companyId) {
      throw reconciliationError('INVOICE_NOT_FOUND');
    }
    if (invoice.status === 'draft' || invoice.status === 'cancelled' || invoice.kind === 'credit_note') {
      throw reconciliationError('INVOICE_NOT_PAYABLE');
    }
    const amountCents = invoice.totals().netToPay - invoice.paid;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw reconciliationError('INVOICE_ALREADY_PAID');
    }

    const attemptId = this.ids.newId();
    await this.persistence.runWithTenant(input.companyId, () =>
      this.persistence.stripeBilling.createCheckoutAttempt({
        id: attemptId,
        companyId: input.companyId,
        purpose: 'invoice_payment',
        plan: null,
        invoiceId: input.invoiceId,
        expectedAmountCents: amountCents,
        currency: 'eur',
        now: this.clock.now(),
      }),
    );

    let checkout: CheckoutResult | null = null;
    try {
      checkout = await this.provider.createInvoicePaymentLink({
        companyId: input.companyId,
        checkoutAttemptId: attemptId,
        invoiceId: input.invoiceId,
        amountCents,
        label: input.label,
      });
      await this.persistence.runWithTenant(input.companyId, () =>
        this.persistence.stripeBilling.attachCheckoutSession({
          companyId: input.companyId,
          attemptId,
          stripeSessionId: checkout!.sessionId,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          now: this.clock.now(),
        }),
      );
      return checkout;
    } catch (error) {
      if (checkout) await this.provider.expireCheckoutSession(checkout.sessionId).catch(() => undefined);
      await this.persistence
        .runWithTenant(input.companyId, () =>
          this.persistence.stripeBilling.markCheckoutFailed({
            companyId: input.companyId,
            attemptId,
            failureCode: providerFailureCode(error),
            now: this.clock.now(),
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<StripeWebhookReceipt> {
    if (rawBody.length === 0) throw reconciliationError('STRIPE_WEBHOOK_BODY_REQUIRED');
    if (!signature) throw reconciliationError('STRIPE_SIGNATURE_REQUIRED');
    let event: VerifiedStripeWebhookEvent;
    try {
      event = this.provider.verifyWebhook(rawBody, signature);
    } catch (error) {
      throw reconciliationError(providerFailureCode(error));
    }
    if (event.livemode !== this.provider.expectedLivemode) {
      throw reconciliationError('STRIPE_EVENT_MODE_MISMATCH');
    }
    const locator = locateStripeReconciliation(event);
    if (locator.kind === 'ignored') {
      return { received: true, eventId: event.id, outcome: 'ignored' };
    }
    const companyId = locator.companyId;
    const now = this.clock.now();
    const claim = await this.persistence.runWithTenant(companyId, () =>
      this.persistence.stripeBilling.claimWebhook({
        eventId: event.id,
        companyId,
        eventType: event.type,
        providerCreatedAt: eventInstant(event),
        payloadSha256: payloadSha256(rawBody),
        livemode: event.livemode,
        apiVersion: event.apiVersion,
        now,
      }),
    );
    if (claim === 'already_processed') {
      return { received: true, eventId: event.id, outcome: 'replayed' };
    }
    if (claim === 'already_processing') {
      throw reconciliationError('STRIPE_EVENT_PROCESSING', true);
    }

    try {
      if (locator.kind === 'checkout') await this.reconcileCheckout(event, locator);
      else if (locator.kind === 'subscription_invoice') {
        await this.reconcileSubscriptionInvoice(event, locator);
      } else {
        await this.reconcileSubscription(event, locator);
      }
      return { received: true, eventId: event.id, outcome: 'processed' };
    } catch (error) {
      await this.persistence
        .runWithTenant(companyId, () =>
          this.persistence.stripeBilling.markWebhookFailed({
            companyId,
            eventId: event.id,
            failureCode: providerFailureCode(error),
            now: this.clock.now(),
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private async reconcileCheckout(
    event: VerifiedStripeWebhookEvent,
    locator: Extract<StripeReconciliationLocator, { kind: 'checkout' }>,
  ): Promise<void> {
    const session = await this.provider.retrieveCheckoutSession(locator.stripeSessionId);
    assertSame(session.id, locator.stripeSessionId, 'STRIPE_CHECKOUT_SESSION_MISMATCH');
    requireMetadata(session.metadata, 'bob_company_id', locator.companyId);
    requireMetadata(session.metadata, 'bob_checkout_id', locator.checkoutAttemptId);
    requireMetadata(session.metadata, 'bob_purpose', locator.purpose);

    if (session.status === 'expired') {
      await this.persistence.runWithTenant(locator.companyId, () =>
        this.persistence.runInTransaction(async () => {
          validateAttempt(
            await this.persistence.stripeBilling.lockCheckoutAttempt(
              locator.companyId,
              locator.checkoutAttemptId,
            ),
            locator,
          );
          await this.persistence.stripeBilling.expireCheckoutAttempt({
            companyId: locator.companyId,
            attemptId: locator.checkoutAttemptId,
            stripeSessionId: locator.stripeSessionId,
            now: this.clock.now(),
          });
          await this.persistence.stripeBilling.markWebhookProcessed({
            companyId: locator.companyId,
            eventId: event.id,
            now: this.clock.now(),
          });
        }),
      );
      return;
    }

    if (locator.purpose === 'subscription') {
      if (session.mode !== 'subscription' || !session.customerId || !session.subscriptionId) {
        throw reconciliationError('STRIPE_SUBSCRIPTION_CHECKOUT_INCOMPLETE', true);
      }
      const snapshot = await this.provider.retrieveSubscription(session.subscriptionId);
      const subLocator = {
        kind: 'subscription' as const,
        companyId: locator.companyId,
        checkoutAttemptId: locator.checkoutAttemptId,
        stripeSubscriptionId: session.subscriptionId,
      };
      validateSubscriptionSnapshot(snapshot, subLocator);
      assertSame(snapshot.customerId, session.customerId, 'STRIPE_CUSTOMER_MISMATCH');
      await this.applySubscription(event, subLocator, snapshot, session, locator, null);
      return;
    }

    await this.reconcileInvoiceCheckout(event, locator, session);
  }

  private async reconcileInvoiceCheckout(
    event: VerifiedStripeWebhookEvent,
    locator: Extract<StripeReconciliationLocator, { kind: 'checkout' }>,
    session: StripeCheckoutSessionSnapshot,
  ): Promise<void> {
    if (session.mode !== 'payment') throw reconciliationError('STRIPE_INVOICE_CHECKOUT_MODE_INVALID');
    if (session.status !== 'complete' || session.paymentStatus !== 'paid') {
      await this.persistence.runWithTenant(locator.companyId, () =>
        this.persistence.runInTransaction(async () => {
          validateAttempt(
            await this.persistence.stripeBilling.lockCheckoutAttempt(
              locator.companyId,
              locator.checkoutAttemptId,
            ),
            locator,
          );
          await this.persistence.stripeBilling.markWebhookProcessed({
            companyId: locator.companyId,
            eventId: event.id,
            now: this.clock.now(),
          });
        }),
      );
      return;
    }
    if (!session.paymentIntentId || session.currency?.toLowerCase() !== 'eur') {
      throw reconciliationError('STRIPE_INVOICE_PAYMENT_PROOF_INVALID');
    }

    await this.persistence.runWithTenant(locator.companyId, () =>
      this.persistence.runInTransaction(async () => {
        const attempt = validateAttempt(
          await this.persistence.stripeBilling.lockCheckoutAttempt(
            locator.companyId,
            locator.checkoutAttemptId,
          ),
          locator,
        );
        if (!attempt.invoiceId || attempt.expectedAmountCents === null) {
          throw reconciliationError('STRIPE_INVOICE_ATTEMPT_INVALID');
        }
        if (session.amountTotal !== attempt.expectedAmountCents) {
          throw reconciliationError('STRIPE_INVOICE_AMOUNT_MISMATCH');
        }
        requireMetadata(session.metadata, 'bob_invoice_id', attempt.invoiceId);
        const recorded = await new RegisterPayment({
          invoices: this.persistence.invoices,
          payments: this.persistence.payments,
          uow: this.persistence,
          ids: this.ids,
          clock: { ...this.clock, now: () => eventInstant(event) },
          afterPaymentRecorded: async ({ paymentId }) =>
            new RecordPaymentAccountingEntry({
              invoices: this.persistence.invoices,
              payments: this.persistence.payments,
              entries: this.persistence.accountingEntries,
              charts: this.persistence.chartOfAccounts,
            }).execute({ companyId: locator.companyId, paymentId }),
        }).execute({
          invoiceId: attempt.invoiceId,
          amount: attempt.expectedAmountCents,
          method: 'card',
          idempotencyKey: `stripe:checkout:${session.id}`,
        });
        if (!recorded.ok) throw new StripePaymentApplicationError(recorded.error);
        await this.persistence.stripeBilling.completeCheckoutAttempt({
          companyId: locator.companyId,
          attemptId: locator.checkoutAttemptId,
          stripeSessionId: locator.stripeSessionId,
          stripeCustomerId: session.customerId,
          stripeSubscriptionId: null,
          stripePaymentIntentId: session.paymentIntentId,
          now: this.clock.now(),
        });
        await this.persistence.stripeBilling.markWebhookProcessed({
          companyId: locator.companyId,
          eventId: event.id,
          now: this.clock.now(),
        });
      }),
    );
  }

  private async reconcileSubscription(
    event: VerifiedStripeWebhookEvent,
    locator: Extract<StripeReconciliationLocator, { kind: 'subscription' }>,
  ): Promise<void> {
    const snapshot = await this.provider.retrieveSubscription(locator.stripeSubscriptionId);
    validateSubscriptionSnapshot(snapshot, locator);
    await this.applySubscription(event, locator, snapshot, null, null, null);
  }

  private async reconcileSubscriptionInvoice(
    event: VerifiedStripeWebhookEvent,
    locator: Extract<StripeReconciliationLocator, { kind: 'subscription_invoice' }>,
  ): Promise<void> {
    const invoice = await this.provider.retrieveSubscriptionInvoice(locator.stripeInvoiceId);
    validateSubscriptionInvoiceSnapshot(invoice, locator);
    const snapshot = await this.provider.retrieveSubscription(locator.stripeSubscriptionId);
    const subscriptionLocator = {
      kind: 'subscription' as const,
      companyId: locator.companyId,
      checkoutAttemptId: locator.checkoutAttemptId,
      stripeSubscriptionId: locator.stripeSubscriptionId,
    };
    validateSubscriptionSnapshot(snapshot, subscriptionLocator);
    assertSame(
      invoice.stripeCustomerId,
      snapshot.customerId,
      'STRIPE_INVOICE_CUSTOMER_MISMATCH',
    );
    await this.applySubscription(
      event,
      subscriptionLocator,
      snapshot,
      null,
      null,
      invoice,
    );
  }

  private async applySubscription(
    event: VerifiedStripeWebhookEvent,
    locator: Extract<StripeReconciliationLocator, { kind: 'subscription' }>,
    snapshot: StripeSubscriptionSnapshot,
    session: StripeCheckoutSessionSnapshot | null,
    checkoutLocator: Extract<StripeReconciliationLocator, { kind: 'checkout' }> | null,
    invoiceSnapshot: StripeSubscriptionInvoiceSnapshot | null,
  ): Promise<void> {
    const tier = this.provider.tierForPriceIds(snapshot.priceIds);
    if (!tier) throw reconciliationError('STRIPE_SUBSCRIPTION_PRICE_UNMAPPED', true);
    const status = subscriptionStatus(snapshot.status);
    if ((status === 'active' || status === 'trialing') && snapshot.currentPeriodEnd === null) {
      throw reconciliationError('STRIPE_SUBSCRIPTION_PERIOD_MISSING', true);
    }
    await this.persistence.runWithTenant(locator.companyId, () =>
      this.persistence.runInTransaction(async () => {
        const persisted = await this.persistence.subscriptions.findByCompanyId(locator.companyId);
        if (!persisted) throw reconciliationError('SUBSCRIPTION_PROVISIONING_REQUIRED', true);
        const existingBinding = stripeBindingOf(persisted);
        if (existingBinding) {
          assertSame(
            existingBinding.customerId,
            snapshot.customerId,
            'STRIPE_CUSTOMER_BINDING_MISMATCH',
          );
          assertSame(
            existingBinding.subscriptionId,
            snapshot.id,
            'STRIPE_SUBSCRIPTION_BINDING_MISMATCH',
          );
        } else if (locator.checkoutAttemptId === null) {
          // Une souscription créée manuellement dans le Dashboard ne peut jamais se lier à un
          // tenant en copiant seulement une metadata companyId.
          throw reconciliationError('STRIPE_CHECKOUT_AUTHORITY_REQUIRED');
        }
        if (checkoutLocator) {
          const attempt = validateAttempt(
            await this.persistence.stripeBilling.lockCheckoutAttempt(
              checkoutLocator.companyId,
              checkoutLocator.checkoutAttemptId,
            ),
            checkoutLocator,
          );
          if (existingBinding === null && attempt.plan !== tier) {
            throw reconciliationError('STRIPE_CHECKOUT_PLAN_MISMATCH');
          }
        } else if (existingBinding === null && locator.checkoutAttemptId !== null) {
          const attempt = await this.persistence.stripeBilling.lockCheckoutAttempt(
            locator.companyId,
            locator.checkoutAttemptId,
          );
          if (
            !attempt ||
            attempt.companyId !== locator.companyId ||
            attempt.purpose !== 'subscription' ||
            attempt.plan !== tier ||
            !['creating', 'open', 'completed'].includes(attempt.status) ||
            (attempt.stripeCustomerId !== null && attempt.stripeCustomerId !== snapshot.customerId) ||
            (attempt.stripeSubscriptionId !== null &&
              attempt.stripeSubscriptionId !== snapshot.id)
          ) {
            throw reconciliationError('STRIPE_CHECKOUT_AUTHORITY_MISMATCH');
          }
        }
        await this.persistence.stripeBilling.applySubscription({
          companyId: locator.companyId,
          checkoutAttemptId: locator.checkoutAttemptId,
          stripeCustomerId: snapshot.customerId,
          stripeSubscriptionId: snapshot.id,
          plan: tier,
          status,
          trialEndsAt: snapshot.trialEndsAt,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          eventId: event.id,
          now: this.clock.now(),
        });
        if (invoiceSnapshot !== null) {
          await this.persistence.stripeBilling.upsertSubscriptionInvoice({
            companyId: locator.companyId,
            eventId: event.id,
            snapshot: invoiceSnapshot,
            now: this.clock.now(),
          });
        }
        if (session && checkoutLocator) {
          await this.persistence.stripeBilling.completeCheckoutAttempt({
            companyId: checkoutLocator.companyId,
            attemptId: checkoutLocator.checkoutAttemptId,
            stripeSessionId: checkoutLocator.stripeSessionId,
            stripeCustomerId: snapshot.customerId,
            stripeSubscriptionId: snapshot.id,
            stripePaymentIntentId: null,
            now: this.clock.now(),
          });
        }
        await this.persistence.stripeBilling.markWebhookProcessed({
          companyId: locator.companyId,
          eventId: event.id,
          now: this.clock.now(),
        });
      }),
    );
    this.logger.audit('stripe.subscription_reconciled', {
      companyId: locator.companyId,
      eventId: event.id,
      subscriptionId: snapshot.id,
      status,
      plan: tier,
    });
  }
}

class StripePaymentApplicationError extends Error {
  constructor(readonly appError: AppError) {
    super('STRIPE_PAYMENT_APPLICATION_ERROR');
  }
}
