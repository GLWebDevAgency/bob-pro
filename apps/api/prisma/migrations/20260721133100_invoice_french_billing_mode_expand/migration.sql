-- BT-23 France 2026 — EXPAND uniquement : les archives historiques restent NULL et le writer
-- applicatif renseigne toutes les nouvelles émissions. Le contrat DB draft→issued viendra après
-- retrait de N-1 ; aucune valeur réglementaire n'est rétro-inventée.
BEGIN;

ALTER TABLE "invoices"
  ADD COLUMN "frenchBillingModeAtIssuance" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_french_billing_mode_valid"
  CHECK (
    "frenchBillingModeAtIssuance" IS NULL
    OR "frenchBillingModeAtIssuance" IN (
      'B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'B4', 'S4', 'M4', 'S5', 'S6', 'B7', 'S7', 'M7'
    )
  ) NOT VALID;
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_french_billing_mode_valid";

-- Un avoir est juridiquement déterminé par sa source dès sa création : son régime TVA et son
-- cadre BT-23 peuvent donc être copiés dans le brouillon immuable. Hors avoir, ces faits
-- n'existent qu'à l'émission.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_vat_treatment_requires_issue";
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vat_treatment_requires_issue"
  CHECK (
    "vatTreatmentAtIssuance" IS NULL
    OR "issuedAt" IS NOT NULL
    OR kind = 'credit_note'
  ) NOT VALID;
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_vat_treatment_requires_issue";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_french_billing_mode_requires_issue"
  CHECK (
    "frenchBillingModeAtIssuance" IS NULL
    OR "issuedAt" IS NOT NULL
    OR kind = 'credit_note'
  ) NOT VALID;
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_french_billing_mode_requires_issue";

CREATE OR REPLACE FUNCTION enforce_invoice_fiscal_traceability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_fiscal RECORD;
BEGIN
  -- Les deux faits fiscaux sont immuables dès que la pièce a quitté le brouillon.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND (
    NEW."vatTreatmentAtIssuance" IS DISTINCT FROM OLD."vatTreatmentAtIssuance"
    OR NEW."frenchBillingModeAtIssuance" IS DISTINCT FROM OLD."frenchBillingModeAtIssuance"
  ) THEN
    RAISE EXCEPTION 'issued invoice fiscal fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_issued_fiscal_immutability';
  END IF;

  -- Un avoir copie exactement les faits fiscaux de sa source, y compris NULL pour une archive
  -- legacy. Aucun recalcul depuis les fiches société/client courantes n'est accepté.
  IF NEW.kind = 'credit_note' AND NEW."sourceInvoiceId" IS NOT NULL THEN
    SELECT "vatTreatmentAtIssuance", "frenchBillingModeAtIssuance"
      INTO source_fiscal
      FROM public.invoices
     WHERE id = NEW."sourceInvoiceId"
       AND "companyId" = NEW."companyId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit note fiscal source must belong to the same tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'invoices_credit_note_fiscal_source_tenant';
    END IF;
    IF NEW."vatTreatmentAtIssuance" IS DISTINCT FROM source_fiscal."vatTreatmentAtIssuance"
      OR NEW."frenchBillingModeAtIssuance" IS DISTINCT FROM source_fiscal."frenchBillingModeAtIssuance" THEN
      RAISE EXCEPTION 'credit note fiscal facts must mirror source invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_fiscal_mirror';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_fiscal_traceability ON "invoices";
CREATE TRIGGER invoices_fiscal_traceability
BEFORE INSERT OR UPDATE ON "invoices"
FOR EACH ROW
EXECUTE FUNCTION enforce_invoice_fiscal_traceability();

COMMIT;
