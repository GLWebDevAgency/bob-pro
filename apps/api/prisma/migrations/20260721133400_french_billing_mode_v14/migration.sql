-- CIUS France v1.4.0 (publication FNFE France_RFE v1.4.0.02, 14 juillet 2026).
-- BR-FR-08 remplace la liste BT-23 : M7 est retiré ; S3/B8/S8/M8/B9/S9/M9 sont ajoutés.
-- La colonne reste TEXT pour permettre l'expand/contract ; aucune archive n'est réécrite.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE invoices DROP CONSTRAINT invoices_french_billing_mode_valid;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_french_billing_mode_valid
  CHECK (
    "frenchBillingModeAtIssuance" IS NULL
    OR "frenchBillingModeAtIssuance" IN (
      'B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'S3',
      'B4', 'S4', 'M4', 'S5', 'S6', 'B7', 'S7',
      'B8', 'S8', 'M8', 'B9', 'S9', 'M9'
    )
  ) NOT VALID;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_french_billing_mode_valid;

COMMIT;
