import { type PlanTier } from '../../domain/subscription/plan';

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

/** Abstraction du fournisseur de paiement. Le runtime exige un fournisseur live configuré. */
export interface PaymentGatewayPort {
  /** Abonnement SaaS : l'artisan souscrit une offre. */
  createSubscriptionCheckout(input: {
    companyId: string;
    checkoutAttemptId?: string;
    tier: PlanTier;
    /** Identité fournisseur déjà liée ; null lors du premier checkout. */
    stripeCustomerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult>;

  /** Portail de facturation Stripe (gérer l'abonnement, moyens de paiement). */
  createBillingPortal(input: {
    /** Obligatoire en production ; `companyId` n'est toléré que pour casser explicitement l'ancien appel. */
    stripeCustomerId?: string;
    companyId?: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  /** Lien de paiement en ligne d'une facture par le client de l'artisan. */
  createInvoicePaymentLink(input: {
    companyId?: string;
    checkoutAttemptId?: string;
    invoiceId: string;
    amountCents: number;
    label: string;
  }): Promise<{ url: string }>;
}
