-- L'échéance d'une facture a des effets légaux, de relance et de trésorerie. Elle ne peut donc
-- pas provenir d'un fallback applicatif. Aucune valeur n'est rétro-remplie : NULL signifie que
-- le propriétaire doit confirmer ses conditions avant la prochaine émission.
ALTER TABLE "company_billing_settings"
  ADD COLUMN "defaultInvoicePaymentTermsDays" INTEGER;

ALTER TABLE "company_billing_settings"
  ADD CONSTRAINT "company_billing_settings_invoice_payment_terms_days_check"
  CHECK (
    "defaultInvoicePaymentTermsDays" IS NULL
    OR "defaultInvoicePaymentTermsDays" BETWEEN 1 AND 60
  );
