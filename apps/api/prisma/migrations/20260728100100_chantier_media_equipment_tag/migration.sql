-- PR-11b « Le métier » (Bloc A) — historique/photos PAR ÉQUIPEMENT sans nouvelle table :
-- equipmentId NULLABLE ADDITIF sur chantier_notes / chantier_photos (lignes historiques non
-- taguées, AUCUN backfill — les writers N-1 continuent d'insérer sans la colonne).
--
-- FK et CHECK posés NOT VALID (leçon release 25/07 : verrou compatible writers N-1 sur des
-- tables vivantes) — la validation vit dans la migration séparée
-- 20260728100200_chantier_media_equipment_tag_validate.
--
-- Trigger equipment_scope_coherence (même famille que invoices_legal_traceability, version
-- INITIALE — aucun corps antérieur à reprendre) : une trace taguée doit viser un équipement
-- DU MÊME SITE et DU MÊME TENANT. La FK composite (equipmentId, companyId) tient déjà le
-- tenant ; le trigger tient la cohérence de SITE que la FK ne peut pas exprimer.
--
-- Index PARTIELS (companyId, equipmentId, createdAt DESC) WHERE equipmentId IS NOT NULL —
-- l'historique d'un équipement ne balaie jamais les traces non taguées. [Amélioration 8]
-- CREATE INDEX non-CONCURRENTLY ASSUMÉ et documenté : volumétrie bêta faible + lock_timeout
-- 5s posé. Règle de bascule : si au déploiement une des tables dépasse ~100k lignes en prod,
-- l'index part en CONCURRENTLY hors transaction (migration dédiée).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "chantier_notes"
  ADD COLUMN "equipmentId" TEXT;

ALTER TABLE "chantier_photos"
  ADD COLUMN "equipmentId" TEXT;

ALTER TABLE "chantier_notes"
  ADD CONSTRAINT "chantier_notes_equipment_company_fkey"
  FOREIGN KEY ("equipmentId", "companyId") REFERENCES "equipments"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "chantier_photos"
  ADD CONSTRAINT "chantier_photos_equipment_company_fkey"
  FOREIGN KEY ("equipmentId", "companyId") REFERENCES "equipments"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Identifiant canonique quand présent (même hygiène qu'expenses_chantier_id_check).
ALTER TABLE "chantier_notes"
  ADD CONSTRAINT "chantier_notes_equipment_id_check" CHECK (
    "equipmentId" IS NULL
    OR (
      char_length("equipmentId") BETWEEN 1 AND 200
      AND "equipmentId" = btrim("equipmentId")
      AND "equipmentId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE "chantier_photos"
  ADD CONSTRAINT "chantier_photos_equipment_id_check" CHECK (
    "equipmentId" IS NULL
    OR (
      char_length("equipmentId") BETWEEN 1 AND 200
      AND "equipmentId" = btrim("equipmentId")
      AND "equipmentId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

CREATE INDEX "chantier_notes_equipment_created_idx"
  ON "chantier_notes"("companyId", "equipmentId", "createdAt" DESC)
  WHERE "equipmentId" IS NOT NULL;

CREATE INDEX "chantier_photos_equipment_created_idx"
  ON "chantier_photos"("companyId", "equipmentId", "createdAt" DESC)
  WHERE "equipmentId" IS NOT NULL;

-- Cohérence équipement↔site en défense en profondeur : la garde use case (fail-closed) est la
-- première ligne, ce trigger interdit qu'un défaut applicatif tague une trace vers un
-- équipement d'un AUTRE site. Il ne s'applique qu'aux lignes taguées : la forme N-1 (sans
-- equipmentId) traverse intacte — writer N-1 rejoué par la certification.
CREATE OR REPLACE FUNCTION enforce_equipment_scope_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  equipment_chantier TEXT;
BEGIN
  IF NEW."equipmentId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT e."chantierId" INTO equipment_chantier
    FROM "equipments" e
   WHERE e."id" = NEW."equipmentId"
     AND e."companyId" = NEW."companyId";
  IF equipment_chantier IS NULL THEN
    RAISE EXCEPTION 'EQUIPMENT_SCOPE_UNKNOWN_EQUIPMENT'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_scope_coherence';
  END IF;
  IF equipment_chantier <> NEW."chantierId" THEN
    RAISE EXCEPTION 'EQUIPMENT_SCOPE_CHANTIER_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_scope_coherence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS equipment_scope_coherence ON "chantier_notes";
CREATE TRIGGER equipment_scope_coherence
BEFORE INSERT OR UPDATE ON "chantier_notes"
FOR EACH ROW
EXECUTE FUNCTION enforce_equipment_scope_coherence();

DROP TRIGGER IF EXISTS equipment_scope_coherence ON "chantier_photos";
CREATE TRIGGER equipment_scope_coherence
BEFORE INSERT OR UPDATE ON "chantier_photos"
FOR EACH ROW
EXECUTE FUNCTION enforce_equipment_scope_coherence();

COMMENT ON FUNCTION enforce_equipment_scope_coherence() IS
  'PR-11 : une note/photo taguée équipement vise un équipement du MÊME site et du MÊME tenant ; forme N-1 (equipmentId NULL) inchangée.';

COMMIT;
