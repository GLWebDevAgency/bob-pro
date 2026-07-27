-- PR-08 « Le métier » — sites sur les pièces : chantierId NULLABLE sur quotes et invoices
-- (patron Expense.chantierId, migration 20260719020000). Extension PUREMENT ADDITIVE :
-- NULL = pièce hors site, AUCUN backfill (les pièces historiques restent honnêtement hors
-- site) ; les writers N-1 continuent d'insérer sans la colonne.
--
-- FK et CHECK posés NOT VALID (leçon release 25/07 : verrou compatible writers N-1 sur des
-- tables légales vivantes) — la validation vit dans la migration séparée
-- 20260727100100_pieces_chantier_scope_validate.
--
-- Le FIGEAGE post-émission d'invoices.chantierId (liste du trigger
-- invoices_legal_traceability) arrive avec PR-12b : redéfinition COMPLÈTE du trigger depuis sa
-- DERNIÈRE version en date (annexe errata n° 1 de la conception P1), writer N-1 rejoué sous
-- chaque état — jamais un corps périmé recopié ici.
--
-- Index non-CONCURRENTLY ASSUMÉ et documenté (amélioration 8 de la conception) : volumétrie
-- bêta faible + lock_timeout 5s posé. Règle de bascule : si au moment du déploiement une des
-- tables dépasse ~100k lignes en prod, l'index part en CONCURRENTLY hors transaction
-- (migration dédiée).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "quotes"
  ADD COLUMN "chantierId" TEXT;

ALTER TABLE "invoices"
  ADD COLUMN "chantierId" TEXT;

-- Intégrité tenant : le chantier référencé appartient AU MÊME tenant que la pièce
-- (FK composite sur uniq_chantier_id_company, même convention qu'expenses/chantier_notes).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_chantier_company_fkey"
  FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_chantier_company_fkey"
  FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Identifiant canonique quand présent (même hygiène qu'expenses_chantier_id_check).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_chantier_id_check" CHECK (
    "chantierId" IS NULL
    OR (
      char_length("chantierId") BETWEEN 1 AND 200
      AND "chantierId" = btrim("chantierId")
      AND "chantierId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_chantier_id_check" CHECK (
    "chantierId" IS NULL
    OR (
      char_length("chantierId") BETWEEN 1 AND 200
      AND "chantierId" = btrim("chantierId")
      AND "chantierId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

-- Lecture « pièces d'un site » servie par index (patron expenses_company_chantier_idx).
CREATE INDEX "quotes_company_chantier_idx"
  ON "quotes"("companyId", "chantierId");

CREATE INDEX "invoices_company_chantier_idx"
  ON "invoices"("companyId", "chantierId");

COMMIT;
