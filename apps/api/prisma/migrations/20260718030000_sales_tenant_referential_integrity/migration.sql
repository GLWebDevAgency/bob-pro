-- Les identifiants de sociétés et de clients sont tous issus du JWT/de PostgreSQL, mais la base
-- doit rester sûre même face à un défaut applicatif ou une écriture administrative forgée.
-- On refuse d'appliquer les contraintes si une ligne historique est orpheline ou inter-tenant :
-- aucune réparation silencieuse d'une pièce comptable n'est juridiquement acceptable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "quotes" q
    LEFT JOIN "customers" c
      ON c."id" = q."customerId" AND c."companyId" = q."companyId"
    WHERE c."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot certify sales tenant integrity: invalid quote/customer binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "invoices" i
    LEFT JOIN "customers" c
      ON c."id" = i."customerId" AND c."companyId" = i."companyId"
    WHERE c."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot certify sales tenant integrity: invalid invoice/customer binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "invoices" i
    LEFT JOIN "quotes" q
      ON q."id" = i."parentQuoteId" AND q."companyId" = i."companyId"
    WHERE i."parentQuoteId" IS NOT NULL AND q."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot certify sales tenant integrity: invalid invoice/quote binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "invoices" i
    LEFT JOIN "invoices" deposit
      ON deposit."id" = i."depositInvoiceId" AND deposit."companyId" = i."companyId"
    WHERE i."depositInvoiceId" IS NOT NULL AND deposit."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot certify sales tenant integrity: invalid deposit invoice binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "payments" p
    LEFT JOIN "invoices" i
      ON i."id" = p."invoiceId" AND i."companyId" = p."companyId"
    WHERE i."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot certify sales tenant integrity: invalid payment/invoice binding';
  END IF;
END $$;

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_customer_tenant_fkey"
  FOREIGN KEY ("customerId", "companyId")
  REFERENCES "customers"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_customer_tenant_fkey"
  FOREIGN KEY ("customerId", "companyId")
  REFERENCES "customers"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoices_parent_quote_tenant_fkey"
  FOREIGN KEY ("parentQuoteId", "companyId")
  REFERENCES "quotes"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoices_deposit_tenant_fkey"
  FOREIGN KEY ("depositInvoiceId", "companyId")
  REFERENCES "invoices"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_invoiceId_fkey",
  ADD CONSTRAINT "payments_invoice_tenant_fkey"
  FOREIGN KEY ("invoiceId", "companyId")
  REFERENCES "invoices"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "quotes_customer_company_idx"
  ON "quotes"("customerId", "companyId");
CREATE INDEX "invoices_customer_company_idx"
  ON "invoices"("customerId", "companyId");
CREATE INDEX "invoices_deposit_company_idx"
  ON "invoices"("depositInvoiceId", "companyId")
  WHERE "depositInvoiceId" IS NOT NULL;
DROP INDEX "payments_invoiceId_idx";
CREATE INDEX "payments_invoice_company_idx"
  ON "payments"("invoiceId", "companyId");
