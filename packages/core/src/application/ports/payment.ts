import { type PlanTier } from '../../domain/subscription/plan';

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

/** Abstraction du fournisseur de paiement (Stripe). Adapters : Stripe (prod) & Demo (sans clé). */
export interface PaymentGatewayPort {
  /** Abonnement SaaS : l'artisan souscrit une offre. */
  createSubscriptionCheckout(input: {
    companyId: string;
    tier: PlanTier;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult>;

  /** Portail de facturation Stripe (gérer l'abonnement, moyens de paiement). */
  createBillingPortal(input: { companyId: string; returnUrl: string }): Promise<{ url: string }>;

  /** Lien de paiement en ligne d'une facture par le client de l'artisan. */
  createInvoicePaymentLink(input: { invoiceId: string; amountCents: number; label: string }): Promise<{ url: string }>;
}
