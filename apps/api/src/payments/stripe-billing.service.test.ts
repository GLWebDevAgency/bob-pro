import { describe, expect, it } from 'vitest';
import type { SubscriptionRecord } from '@bob/core';
import { AppLogger } from '../observability/logger';
import { StripeBillingService } from './stripe-billing.service';
import type {
  ApplyStripeSubscriptionInput,
  CreateStripeCheckoutAttemptInput,
  StripeBillingProvider,
  StripeBillingRepository,
  StripeCheckoutAttempt,
  StripeSubscriptionSnapshot,
  StripeWebhookClaim,
  StripeWebhookClaimInput,
  VerifiedStripeWebhookEvent,
} from './stripe-billing-contract';

type EventRow = StripeWebhookClaimInput & { status: 'processing' | 'processed' | 'failed' };

class MemoryStripeBilling implements StripeBillingRepository {
  readonly attempts = new Map<string, StripeCheckoutAttempt>();
  readonly events = new Map<string, EventRow>();
  subscription: ApplyStripeSubscriptionInput | null = null;
  failAfterSubscriptionWrite = false;

  snapshot(): string {
    return JSON.stringify({
      attempts: [...this.attempts],
      events: [...this.events],
      subscription: this.subscription,
    });
  }

  restore(serialized: string): void {
    const value = JSON.parse(serialized) as {
      attempts: [string, StripeCheckoutAttempt][];
      events: [string, EventRow][];
      subscription: ApplyStripeSubscriptionInput | null;
    };
    this.attempts.clear();
    for (const entry of value.attempts) this.attempts.set(...entry);
    this.events.clear();
    for (const entry of value.events) this.events.set(...entry);
    this.subscription = value.subscription;
  }

  async createCheckoutAttempt(input: CreateStripeCheckoutAttemptInput): Promise<StripeCheckoutAttempt> {
    const record: StripeCheckoutAttempt = {
      ...input,
      status: 'creating',
      stripeSessionId: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePaymentIntentId: null,
      failureCode: null,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    };
    this.attempts.set(input.id, record);
    return record;
  }
  async attachCheckoutSession(input: {
    companyId: string;
    attemptId: string;
    stripeSessionId: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    now: string;
  }): Promise<StripeCheckoutAttempt> {
    const existing = this.attempts.get(input.attemptId);
    if (!existing || existing.companyId !== input.companyId) throw new Error('not found');
    const updated = { ...existing, ...input, status: 'open' as const, updatedAt: input.now };
    this.attempts.set(input.attemptId, updated);
    return updated;
  }
  async markCheckoutFailed(): Promise<void> {}
  async lockCheckoutAttempt(_companyId: string, attemptId: string): Promise<StripeCheckoutAttempt | null> {
    return this.attempts.get(attemptId) ?? null;
  }
  async completeCheckoutAttempt(): Promise<void> {}
  async expireCheckoutAttempt(): Promise<void> {}
  async claimWebhook(input: StripeWebhookClaimInput): Promise<StripeWebhookClaim> {
    const current = this.events.get(input.eventId);
    if (current) {
      if (current.companyId !== input.companyId || current.payloadSha256 !== input.payloadSha256) {
        throw new Error('tenant/payload mismatch');
      }
      if (current.status === 'processed') return 'already_processed';
      if (current.status === 'processing') return 'already_processing';
    }
    this.events.set(input.eventId, { ...input, status: 'processing' });
    return 'claimed';
  }
  async markWebhookProcessed(input: { companyId: string; eventId: string }): Promise<void> {
    if (this.failAfterSubscriptionWrite) throw new Error('database write failure');
    const current = this.events.get(input.eventId);
    if (!current || current.companyId !== input.companyId) throw new Error('not found');
    this.events.set(input.eventId, { ...current, status: 'processed' });
  }
  async markWebhookFailed(input: { companyId: string; eventId: string }): Promise<void> {
    const current = this.events.get(input.eventId);
    if (!current || current.companyId !== input.companyId) return;
    this.events.set(input.eventId, { ...current, status: 'failed' });
  }
  async applySubscription(input: ApplyStripeSubscriptionInput): Promise<void> {
    this.subscription = input;
  }
}

function subscriptionEvent(input: {
  id: string;
  companyId: string;
  created?: number;
  payloadStatus?: string;
}): VerifiedStripeWebhookEvent {
  return {
    id: input.id,
    type: 'customer.subscription.updated',
    created: input.created ?? 1_784_275_200,
    livemode: true,
    apiVersion: '2026-02-25.clover',
    dataObject: {
      id: 'sub_live_1',
      status: input.payloadStatus ?? 'canceled',
      metadata: {
        bob_company_id: input.companyId,
        bob_checkout_id: 'checkout-1',
        bob_purpose: 'subscription',
      },
    },
  };
}

function snapshot(companyId = 'co-1'): StripeSubscriptionSnapshot {
  return {
    id: 'sub_live_1',
    customerId: 'cus_live_1',
    status: 'active',
    priceIds: ['price_pro'],
    currentPeriodEnd: '2026-08-17T00:00:00.000Z',
    trialEndsAt: null,
    metadata: {
      bob_company_id: companyId,
      bob_checkout_id: 'checkout-1',
      bob_purpose: 'subscription',
    },
  };
}

function harness(initialEvent: VerifiedStripeWebhookEvent) {
  const store = new MemoryStripeBilling();
  store.attempts.set('checkout-1', {
    id: 'checkout-1',
    companyId: 'co-1',
    purpose: 'subscription',
    status: 'open',
    plan: 'pro',
    invoiceId: null,
    expectedAmountCents: null,
    currency: 'eur',
    stripeSessionId: 'cs_live_1',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePaymentIntentId: null,
    failureCode: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    completedAt: null,
  });
  let verified = initialEvent;
  let currentSnapshot = snapshot();
  let retrieveCount = 0;
  const provider: StripeBillingProvider = {
    expectedLivemode: true,
    createSubscriptionCheckout: async () => ({ url: 'https://checkout.stripe.com/x', sessionId: 'cs_1' }),
    createInvoicePaymentLink: async () => ({ url: 'https://checkout.stripe.com/x', sessionId: 'cs_1' }),
    createBillingPortal: async () => ({ url: 'https://billing.stripe.com/x' }),
    expireCheckoutSession: async () => {},
    verifyWebhook: () => verified,
    retrieveCheckoutSession: async () => {
      throw new Error('not used');
    },
    retrieveSubscription: async () => {
      retrieveCount += 1;
      return currentSnapshot;
    },
    tierForPriceIds: (ids) => (ids.length === 1 && ids[0] === 'price_pro' ? 'pro' : null),
  };
  const record: SubscriptionRecord = {
    id: 'subscription-1',
    companyId: 'co-1',
    plan: 'pro',
    status: 'trialing',
    trialEndsAt: '2026-07-20T00:00:00.000Z',
    currentPeriodEnd: null,
    store: null,
    storeRef: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const persistence = {
    stripeBilling: store,
    subscriptions: { findByCompanyId: async () => record },
    runWithTenant: async <T>(_companyId: string, fn: () => Promise<T>) => fn(),
    runInTransaction: async <T>(fn: () => Promise<T>) => {
      const before = store.snapshot();
      try {
        return await fn();
      } catch (error) {
        store.restore(before);
        throw error;
      }
    },
  };
  return {
    store,
    provider,
    service: new StripeBillingService(
      persistence as never,
      provider,
      new AppLogger(),
    ),
    setEvent: (event: VerifiedStripeWebhookEvent) => {
      verified = event;
    },
    setSnapshot: (value: StripeSubscriptionSnapshot) => {
      currentSnapshot = value;
    },
    retrieveCount: () => retrieveCount,
  };
}

describe('StripeBillingService — webhook durable', () => {
  it('un replay traité ne relit pas Stripe et ne réapplique aucune transition', async () => {
    const event = subscriptionEvent({ id: 'evt_1', companyId: 'co-1' });
    const h = harness(event);
    const first = await h.service.handleWebhook(Buffer.from('payload-1'), 'signature');
    const second = await h.service.handleWebhook(Buffer.from('payload-1'), 'signature');

    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('replayed');
    expect(h.retrieveCount()).toBe(1);
  });

  it("un événement ancien ne peut pas révoquer l'état courant : Stripe est relu comme autorité", async () => {
    const recent = subscriptionEvent({ id: 'evt_recent', companyId: 'co-1', created: 200, payloadStatus: 'active' });
    const h = harness(recent);
    await h.service.handleWebhook(Buffer.from('recent'), 'signature');

    const old = subscriptionEvent({ id: 'evt_old', companyId: 'co-1', created: 100, payloadStatus: 'canceled' });
    h.setEvent(old);
    h.setSnapshot(snapshot());
    await h.service.handleWebhook(Buffer.from('old'), 'signature');

    expect(h.store.subscription).toMatchObject({ status: 'active', plan: 'pro' });
    expect(h.retrieveCount()).toBe(2);
  });

  it('refuse une corrélation vers le mauvais tenant avant toute transition', async () => {
    const forged = subscriptionEvent({ id: 'evt_wrong_tenant', companyId: 'co-b' });
    const h = harness(forged);
    h.setSnapshot(snapshot('co-a'));

    await expect(h.service.handleWebhook(Buffer.from('wrong'), 'signature')).rejects.toThrow(
      'STRIPE_METADATA_MISMATCH:bob_company_id',
    );
    expect(h.store.subscription).toBeNull();
    expect(h.store.events.get('evt_wrong_tenant')?.status).toBe('failed');
  });

  it('refuse une souscription Dashboard qui copie les metadata sans checkout Bob préautorisé', async () => {
    const event = subscriptionEvent({ id: 'evt_manual', companyId: 'co-1' });
    const h = harness(event);
    h.store.attempts.delete('checkout-1');

    await expect(h.service.handleWebhook(Buffer.from('manual'), 'signature')).rejects.toThrow(
      'STRIPE_CHECKOUT_AUTHORITY_MISMATCH',
    );
    expect(h.store.subscription).toBeNull();
  });

  it('refuse un événement sandbox sur une composition live avant toute écriture inbox', async () => {
    const event = { ...subscriptionEvent({ id: 'evt_testmode', companyId: 'co-1' }), livemode: false };
    const h = harness(event);

    await expect(h.service.handleWebhook(Buffer.from('testmode'), 'signature')).rejects.toThrow(
      'STRIPE_EVENT_MODE_MISMATCH',
    );
    expect(h.store.events.size).toBe(0);
  });

  it('rollback la transition abonnement si la finalisation inbox échoue dans la transaction', async () => {
    const event = subscriptionEvent({ id: 'evt_tx', companyId: 'co-1' });
    const h = harness(event);
    h.store.failAfterSubscriptionWrite = true;

    await expect(h.service.handleWebhook(Buffer.from('tx'), 'signature')).rejects.toThrow(
      'database write failure',
    );
    expect(h.store.subscription).toBeNull();
    expect(h.store.events.get('evt_tx')?.status).toBe('failed');
  });
});
