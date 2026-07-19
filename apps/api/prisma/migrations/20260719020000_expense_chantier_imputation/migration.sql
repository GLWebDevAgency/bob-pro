-- Imputation chantier des dépenses (rentabilité par chantier) — extension ADDITIVE, nullable.
-- Backfill : AUCUN — NULL = dépense hors chantier, l'état honnête des lignes historiques
-- (on n'invente jamais un rattachement que le propriétaire n'a pas déclaré).
ALTER TABLE "expenses"
  ADD COLUMN "chantierId" TEXT;

-- Intégrité tenant : le chantier référencé appartient AU MÊME tenant que la dépense
-- (FK composite sur uniq_chantier_id_company, même convention que chantier_notes/chantier_photos).
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_chantier_company_fkey"
  FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Identifiant canonique quand présent (même hygiène que paymentProofDocumentId).
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_chantier_id_check" CHECK (
    "chantierId" IS NULL
    OR (
      char_length("chantierId") BETWEEN 1 AND 200
      AND "chantierId" = btrim("chantierId")
      AND "chantierId" !~ '[[:cntrl:]]'
    )
  );

-- Rentabilité par chantier : lecture « dépenses d'un chantier » servie par index.
CREATE INDEX "expenses_company_chantier_idx"
  ON "expenses"("companyId", "chantierId");
