-- Réconciliation Stripe : aucun succès de retour navigateur ne modifie le métier. Seuls des
-- webhooks signés, inboxés et réconciliés avec l'état courant Stripe peuvent activer un plan ou
-- enregistrer un encaissement client.

ALTER TYPE "SubscriptionStore" ADD VALUE 'stripe';

ALTER TABLE "subscriptions"
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "stripeLastEventId" TEXT,
  ADD COLUMN "stripeLastSyncedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "subscriptions_stripe_customer_key"
  ON "subscriptions"("stripeCustomerId") WHERE "stripeCustomerId" IS NOT NULL;
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_key"
  ON "subscriptions"("stripeSubscriptionId") WHERE "stripeSubscriptionId" IS NOT NULL;

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_stripe_customer_format"
    CHECK ("stripeCustomerId" IS NULL OR "stripeCustomerId" ~ '^cus_[A-Za-z0-9]+$'),
  ADD CONSTRAINT "subscriptions_stripe_subscription_format"
    CHECK ("stripeSubscriptionId" IS NULL OR "stripeSubscriptionId" ~ '^sub_[A-Za-z0-9]+$'),
  ADD CONSTRAINT "subscriptions_stripe_binding_complete"
    CHECK (
      ("stripeCustomerId" IS NULL AND "stripeSubscriptionId" IS NULL)
      OR ("stripeCustomerId" IS NOT NULL AND "stripeSubscriptionId" IS NOT NULL)
    );

CREATE TYPE "StripeCheckoutPurpose" AS ENUM ('subscription', 'invoice_payment');
CREATE TYPE "StripeCheckoutAttemptStatus" AS ENUM (
  'creating',
  'open',
  'completed',
  'expired',
  'failed'
);
CREATE TYPE "StripeWebhookEventStatus" AS ENUM ('processing', 'processed', 'failed');

CREATE TABLE "stripe_checkout_attempts" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "purpose" "StripeCheckoutPurpose" NOT NULL,
  "status" "StripeCheckoutAttemptStatus" NOT NULL DEFAULT 'creating',
  "plan" "SubscriptionPlan",
  "invoiceId" TEXT,
  "expectedAmountCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'eur',
  "stripeSessionId" TEXT,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "stripePaymentIntentId" TEXT,
  "failureCode" VARCHAR(160),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),

  CONSTRAINT "stripe_checkout_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_checkout_attempts_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stripe_checkout_attempts_invoice_tenant_fkey"
    FOREIGN KEY ("invoiceId", "companyId") REFERENCES "invoices"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "stripe_checkout_attempts_shape_check" CHECK (
    (
      "purpose" = 'subscription'
      AND "plan" IS NOT NULL
      AND "plan" <> 'free'
      AND "invoiceId" IS NULL
      AND "expectedAmountCents" IS NULL
    ) OR (
      "purpose" = 'invoice_payment'
      AND "plan" IS NULL
      AND "invoiceId" IS NOT NULL
      AND "expectedAmountCents" > 0
    )
  ),
  CONSTRAINT "stripe_checkout_attempts_currency_check" CHECK ("currency" = 'eur'),
  CONSTRAINT "stripe_checkout_attempts_amount_safe_check" CHECK (
    "expectedAmountCents" IS NULL OR "expectedAmountCents" <= 9007199254740991
  ),
  CONSTRAINT "stripe_checkout_attempts_session_format" CHECK (
    "stripeSessionId" IS NULL OR "stripeSessionId" ~ '^cs_[A-Za-z0-9_]+$'
  ),
  CONSTRAINT "stripe_checkout_attempts_customer_format" CHECK (
    "stripeCustomerId" IS NULL OR "stripeCustomerId" ~ '^cus_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "stripe_checkout_attempts_subscription_format" CHECK (
    "stripeSubscriptionId" IS NULL OR "stripeSubscriptionId" ~ '^sub_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "stripe_checkout_attempts_payment_intent_format" CHECK (
    "stripePaymentIntentId" IS NULL OR "stripePaymentIntentId" ~ '^pi_[A-Za-z0-9_]+$'
  ),
  CONSTRAINT "stripe_checkout_attempts_completion_check" CHECK (
    "status" <> 'completed' OR ("stripeSessionId" IS NOT NULL AND "completedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "stripe_checkout_attempts_session_key"
  ON "stripe_checkout_attempts"("stripeSessionId") WHERE "stripeSessionId" IS NOT NULL;
CREATE UNIQUE INDEX "stripe_checkout_attempts_payment_intent_key"
  ON "stripe_checkout_attempts"("stripePaymentIntentId") WHERE "stripePaymentIntentId" IS NOT NULL;
CREATE INDEX "stripe_checkout_attempts_company_status_idx"
  ON "stripe_checkout_attempts"("companyId", "status", "createdAt" DESC);
CREATE INDEX "stripe_checkout_attempts_invoice_idx"
  ON "stripe_checkout_attempts"("companyId", "invoiceId", "createdAt" DESC)
  WHERE "invoiceId" IS NOT NULL;

CREATE TABLE "stripe_webhook_events" (
  "eventId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" "StripeWebhookEventStatus" NOT NULL,
  "providerCreatedAt" TIMESTAMPTZ(6) NOT NULL,
  "payloadSha256" CHAR(64) NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "apiVersion" VARCHAR(64),
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "processingStartedAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(160),

  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "stripe_webhook_events_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stripe_webhook_events_id_format" CHECK ("eventId" ~ '^evt_[A-Za-z0-9_]+$'),
  CONSTRAINT "stripe_webhook_events_hash_format" CHECK ("payloadSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stripe_webhook_events_attempts_check" CHECK ("attempts" >= 1),
  CONSTRAINT "stripe_webhook_events_processed_check" CHECK (
    ("status" = 'processed' AND "processedAt" IS NOT NULL)
    OR ("status" <> 'processed' AND "processedAt" IS NULL)
  )
);

CREATE INDEX "stripe_webhook_events_company_status_idx"
  ON "stripe_webhook_events"("companyId", "status", "receivedAt" DESC);

ALTER TABLE "stripe_checkout_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_checkout_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_checkout_attempts_tenant_isolation ON "stripe_checkout_attempts"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_webhook_events_tenant_isolation ON "stripe_webhook_events"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
