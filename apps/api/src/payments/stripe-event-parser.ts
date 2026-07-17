import type {
  StripeCheckoutPurpose,
  VerifiedStripeWebhookEvent,
} from './stripe-billing-contract';

type JsonObject = Readonly<Record<string, unknown>>;

export type StripeReconciliationLocator =
  | { kind: 'ignored' }
  | {
      kind: 'checkout';
      companyId: string;
      checkoutAttemptId: string;
      purpose: StripeCheckoutPurpose;
      stripeSessionId: string;
    }
  | {
      kind: 'subscription';
      companyId: string;
      checkoutAttemptId: string | null;
      stripeSubscriptionId: string;
    };

const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

const INVOICE_SUBSCRIPTION_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed']);

function objectOf(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{3,255}$/u.test(value)) {
    throw new Error(`STRIPE_EVENT_INVALID:${field}`);
  }
  return value;
}

function metadataOf(object: JsonObject): Readonly<Record<string, string>> {
  const raw = objectOf(object.metadata);
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function companyIdFrom(metadata: Readonly<Record<string, string>>): string {
  const companyId = metadata.bob_company_id;
  if (!companyId || !/^[A-Za-z0-9-]{1,64}$/u.test(companyId)) {
    throw new Error('STRIPE_EVENT_UNCORRELATED:company');
  }
  return companyId;
}

function checkoutAttemptFrom(metadata: Readonly<Record<string, string>>): string {
  return requiredId(metadata.bob_checkout_id, 'checkout_attempt');
}

function purposeFrom(metadata: Readonly<Record<string, string>>): StripeCheckoutPurpose {
  const purpose = metadata.bob_purpose;
  if (purpose !== 'subscription' && purpose !== 'invoice_payment') {
    throw new Error('STRIPE_EVENT_INVALID:purpose');
  }
  return purpose;
}

function expandableId(value: unknown, field: string): string {
  if (typeof value === 'string') return requiredId(value, field);
  const object = objectOf(value);
  return requiredId(object?.id, field);
}

function invoiceSubscriptionDetails(object: JsonObject): JsonObject | null {
  const parent = objectOf(object.parent);
  return objectOf(parent?.subscription_details);
}

/**
 * Le payload signé ne décide jamais d'un montant, d'un statut ni d'un plan. Il sert seulement à
 * localiser une ressource Stripe, ensuite relue auprès de Stripe avant toute mutation métier.
 */
export function locateStripeReconciliation(event: VerifiedStripeWebhookEvent): StripeReconciliationLocator {
  const object = objectOf(event.dataObject);
  if (!object) throw new Error('STRIPE_EVENT_INVALID:data.object');

  if (CHECKOUT_EVENTS.has(event.type)) {
    const metadata = metadataOf(object);
    return {
      kind: 'checkout',
      companyId: companyIdFrom(metadata),
      checkoutAttemptId: checkoutAttemptFrom(metadata),
      purpose: purposeFrom(metadata),
      stripeSessionId: requiredId(object.id, 'checkout_session'),
    };
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const metadata = metadataOf(object);
    return {
      kind: 'subscription',
      companyId: companyIdFrom(metadata),
      checkoutAttemptId: metadata.bob_checkout_id
        ? requiredId(metadata.bob_checkout_id, 'checkout_attempt')
        : null,
      stripeSubscriptionId: requiredId(object.id, 'subscription'),
    };
  }

  if (INVOICE_SUBSCRIPTION_EVENTS.has(event.type)) {
    const details = invoiceSubscriptionDetails(object);
    if (!details) return { kind: 'ignored' };
    const metadata = metadataOf(details);
    return {
      kind: 'subscription',
      companyId: companyIdFrom(metadata),
      checkoutAttemptId: metadata.bob_checkout_id
        ? requiredId(metadata.bob_checkout_id, 'checkout_attempt')
        : null,
      stripeSubscriptionId: expandableId(details.subscription, 'subscription'),
    };
  }

  return { kind: 'ignored' };
}
