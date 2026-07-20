-- Clientèle principale : donnée déclarative du propriétaire, nullable tant qu'elle n'est pas confirmée.
-- Aucune valeur n'est déduite du métier, des clients existants ou d'une fixture.
CREATE TYPE "CustomerPortfolio" AS ENUM ('b2c', 'b2b', 'b2g', 'mixte');

ALTER TABLE "companies"
  ADD COLUMN "customerPortfolio" "CustomerPortfolio";

-- Preuve structurée d'un règlement fournisseur déjà exécuté hors de Bob.
ALTER TABLE "expenses"
  ADD COLUMN "paymentPaidOn" DATE,
  ADD COLUMN "paymentMethod" "PaymentMethod",
  ADD COLUMN "paymentReference" VARCHAR(140),
  ADD COLUMN "paymentProofDocumentId" VARCHAR(200),
  ADD COLUMN "paymentEvidenceLegacyUnverified" BOOLEAN NOT NULL DEFAULT FALSE;

-- Les anciennes lignes `paid` restent visibles mais sont honnêtement marquées non justifiées.
-- On ne leur invente ni date, ni moyen, ni référence de paiement.
UPDATE "expenses"
SET "paymentEvidenceLegacyUnverified" = TRUE
WHERE "status" = 'paid';

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_payment_reference_check" CHECK (
    "paymentReference" IS NULL
    OR (
      char_length("paymentReference") BETWEEN 1 AND 140
      AND "paymentReference" = btrim("paymentReference")
      AND "paymentReference" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "expenses_payment_proof_id_check" CHECK (
    "paymentProofDocumentId" IS NULL
    OR (
      char_length("paymentProofDocumentId") BETWEEN 1 AND 200
      AND "paymentProofDocumentId" = btrim("paymentProofDocumentId")
      AND "paymentProofDocumentId" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "expenses_payment_evidence_check" CHECK (
    (
      "status" = 'to_pay'
      AND "paymentPaidOn" IS NULL
      AND "paymentMethod" IS NULL
      AND "paymentReference" IS NULL
      AND "paymentProofDocumentId" IS NULL
      AND "paymentEvidenceLegacyUnverified" = FALSE
    )
    OR
    (
      "status" = 'paid'
      AND (
        (
          "paymentPaidOn" IS NOT NULL
          AND "paymentMethod" IS NOT NULL
          AND "paymentEvidenceLegacyUnverified" = FALSE
        )
        OR
        (
          "paymentPaidOn" IS NULL
          AND "paymentMethod" IS NULL
          AND "paymentReference" IS NULL
          AND "paymentProofDocumentId" IS NULL
          AND "paymentEvidenceLegacyUnverified" = TRUE
        )
      )
    )
  ),
  ADD CONSTRAINT "expenses_payment_proof_document_fkey"
    FOREIGN KEY ("companyId", "paymentProofDocumentId")
    REFERENCES "documents"("companyId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "expenses_companyId_paymentProofDocumentId_idx"
  ON "expenses"("companyId", "paymentProofDocumentId");
