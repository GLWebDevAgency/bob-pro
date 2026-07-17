import { describe, expect, it } from 'vitest';
import { locateStripeReconciliation } from './stripe-event-parser';
import type { VerifiedStripeWebhookEvent } from './stripe-billing-contract';

function event(type: string, dataObject: unknown): VerifiedStripeWebhookEvent {
  return { id: 'evt_123', type, created: 1_784_275_200, livemode: true, apiVersion: null, dataObject };
}

describe('locateStripeReconciliation', () => {
  it('localise un checkout uniquement avec les métadonnées Bob scellées lors de sa création', () => {
    expect(
      locateStripeReconciliation(
        event('checkout.session.completed', {
          id: 'cs_live_123',
          metadata: {
            bob_company_id: 'co-1',
            bob_checkout_id: 'checkout-1',
            bob_purpose: 'invoice_payment',
          },
        }),
      ),
    ).toEqual({
      kind: 'checkout',
      companyId: 'co-1',
      checkoutAttemptId: 'checkout-1',
      purpose: 'invoice_payment',
      stripeSessionId: 'cs_live_123',
    });
  });

  it('refuse un événement métier sans tenant corrélable au lieu de chercher un tenant par défaut', () => {
    expect(() =>
      locateStripeReconciliation(
        event('customer.subscription.updated', { id: 'sub_123', metadata: {} }),
      ),
    ).toThrow('STRIPE_EVENT_UNCORRELATED:company');
  });

  it('localise les invoices de souscription via subscription_details, jamais via un invoice client Bob', () => {
    expect(
      locateStripeReconciliation(
        event('invoice.paid', {
          id: 'in_123',
          parent: {
            subscription_details: {
              subscription: 'sub_123',
              metadata: { bob_company_id: 'co-1', bob_checkout_id: 'checkout-1' },
            },
          },
        }),
      ),
    ).toEqual({
      kind: 'subscription',
      companyId: 'co-1',
      checkoutAttemptId: 'checkout-1',
      stripeSubscriptionId: 'sub_123',
    });
  });

  it('ignore explicitement les familles non souscrites', () => {
    expect(locateStripeReconciliation(event('charge.refunded', { id: 'ch_123' }))).toEqual({
      kind: 'ignored',
    });
  });
});
