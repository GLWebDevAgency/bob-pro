-- Historique des factures d'abonnement Stripe. La table ne contient ni payload webhook brut,
-- ni moyen de paiement : uniquement la projection vérifiée auprès de Stripe, tenantée et utile
-- à l'écran « Mon compte ».

CREATE TYPE "StripeSubscriptionInvoiceStatus" AS ENUM (
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible'
);

CREATE TABLE "stripe_subscription_invoices" (
  "stripeInvoiceId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "stripeCustomerId" TEXT NOT NULL,
  "stripeSubscriptionId" TEXT NOT NULL,
  status "StripeSubscriptionInvoiceStatus" NOT NULL,
  currency TEXT NOT NULL,
  number TEXT,
  "subtotalCents" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "amountPaidCents" INTEGER NOT NULL,
  "amountDueCents" INTEGER NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL,
  "periodEnd" TIMESTAMPTZ(6) NOT NULL,
  "issuedAt" TIMESTAMPTZ(6) NOT NULL,
  "paidAt" TIMESTAMPTZ(6),
  "hostedInvoiceUrl" TEXT,
  "invoicePdfUrl" TEXT,
  "stripeLastEventId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stripe_subscription_invoices_pkey" PRIMARY KEY ("stripeInvoiceId"),
  CONSTRAINT "stripe_subscription_invoices_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stripe_subscription_invoices_subscription_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "subscriptions"("companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stripe_subscription_invoices_id_format"
    CHECK ("stripeInvoiceId" ~ '^in_[A-Za-z0-9_]+$'),
  CONSTRAINT "stripe_subscription_invoices_customer_format"
    CHECK ("stripeCustomerId" ~ '^cus_[A-Za-z0-9]+$'),
  CONSTRAINT "stripe_subscription_invoices_subscription_format"
    CHECK ("stripeSubscriptionId" ~ '^sub_[A-Za-z0-9]+$'),
  CONSTRAINT "stripe_subscription_invoices_event_format"
    CHECK ("stripeLastEventId" ~ '^evt_[A-Za-z0-9_]+$'),
  CONSTRAINT "stripe_subscription_invoices_currency_check"
    CHECK (currency = 'eur'),
  CONSTRAINT "stripe_subscription_invoices_amounts_check"
    CHECK (
      "subtotalCents" >= 0
      AND "taxCents" >= 0
      AND "totalCents" >= 0
      AND "amountPaidCents" >= 0
      AND "amountDueCents" >= 0
    ),
  CONSTRAINT "stripe_subscription_invoices_period_check"
    CHECK ("periodEnd" >= "periodStart"),
  CONSTRAINT "stripe_subscription_invoices_paid_check"
    CHECK (status <> 'paid' OR "paidAt" IS NOT NULL),
  CONSTRAINT "stripe_subscription_invoices_number_check"
    CHECK (number IS NULL OR (char_length(number) BETWEEN 1 AND 255)),
  CONSTRAINT "stripe_subscription_invoices_hosted_url_check"
    CHECK ("hostedInvoiceUrl" IS NULL OR "hostedInvoiceUrl" ~ '^https://[^[:space:]]+$'),
  CONSTRAINT "stripe_subscription_invoices_pdf_url_check"
    CHECK ("invoicePdfUrl" IS NULL OR "invoicePdfUrl" ~ '^https://[^[:space:]]+$')
);

CREATE INDEX "stripe_subscription_invoices_company_issued_idx"
  ON "stripe_subscription_invoices"("companyId", "issuedAt" DESC, "stripeInvoiceId" DESC);
CREATE INDEX "stripe_subscription_invoices_subscription_idx"
  ON "stripe_subscription_invoices"("companyId", "stripeSubscriptionId", "issuedAt" DESC);

ALTER TABLE "stripe_subscription_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_subscription_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_subscription_invoices_tenant_isolation ON "stripe_subscription_invoices"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
