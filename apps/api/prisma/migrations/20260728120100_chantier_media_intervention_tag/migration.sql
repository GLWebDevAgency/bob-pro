-- PR-15b « Le métier » (Bloc C) — photos AVANT/APRÈS et notes de PASSAGE sans nouvelle table :
-- interventionId NULLABLE ADDITIF sur chantier_notes / chantier_photos (+ phase sur les photos),
-- lignes historiques non taguées, AUCUN backfill — les writers N-1 continuent d'insérer sans
-- ces colonnes (discipline rejouée par la certification).
--
-- FK et CHECK posés NOT VALID (leçon release 25/07 : verrou compatible writers N-1 sur des
-- tables vivantes) — la validation vit dans 20260728120200_..._validate.
--
-- Trigger intervention_scope_coherence (même famille que equipment_scope_coherence) :
--   1. une trace taguée vise une fiche du MÊME SITE et du MÊME TENANT (la FK composite tient le
--      tenant, le trigger tient la cohérence de SITE que la FK ne peut pas exprimer) ;
--   2. VERROU POST-SIGNATURE §3.4 en défense en profondeur : une fiche `signed` n'accepte plus
--      AUCUNE trace — ni insertion, ni modification, ni RETRAIT (trigger BEFORE DELETE dédié sur
--      les photos). La séquence ERRATUM 6 (retrait de photo → note automatique de résolution,
--      AVANT le sign) reste pleinement acceptée : la fiche est alors `completed`, jamais `signed`.
--
-- Index PARTIELS (companyId, interventionId, createdAt) WHERE interventionId IS NOT NULL — la
-- fiche de passage ne balaie jamais les traces non taguées. [Amélioration 8] CREATE INDEX
-- non-CONCURRENTLY ASSUMÉ et documenté : volumétrie bêta faible + lock_timeout 5s posé. Règle de
-- bascule : au-delà de ~100k lignes en prod, l'index part en CONCURRENTLY hors transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "chantier_notes"
  ADD COLUMN "interventionId" TEXT;

ALTER TABLE "chantier_photos"
  ADD COLUMN "interventionId" TEXT,
  ADD COLUMN "phase" TEXT;

ALTER TABLE "chantier_notes"
  ADD CONSTRAINT "chantier_notes_intervention_company_fkey"
  FOREIGN KEY ("interventionId", "companyId") REFERENCES "interventions"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "chantier_photos"
  ADD CONSTRAINT "chantier_photos_intervention_company_fkey"
  FOREIGN KEY ("interventionId", "companyId") REFERENCES "interventions"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Identifiant canonique quand présent (même hygiène que chantier_*_equipment_id_check).
ALTER TABLE "chantier_notes"
  ADD CONSTRAINT "chantier_notes_intervention_id_check" CHECK (
    "interventionId" IS NULL
    OR (
      char_length("interventionId") BETWEEN 1 AND 200
      AND "interventionId" = btrim("interventionId")
      AND "interventionId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE "chantier_photos"
  ADD CONSTRAINT "chantier_photos_intervention_id_check" CHECK (
    "interventionId" IS NULL
    OR (
      char_length("interventionId") BETWEEN 1 AND 200
      AND "interventionId" = btrim("interventionId")
      AND "interventionId" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

-- Phase GÉNÉRÉE depuis la source TS (InterventionPhotoPhase) — et elle n'a de sens QUE dans un
-- passage : une phase sans fiche est un demi-état, refusée en base comme au use case.
ALTER TABLE "chantier_photos"
  ADD CONSTRAINT "chantier_photos_phase_check" CHECK (
    ("phase" IS NULL OR "phase" IN ('before', 'after'))
    AND ("phase" IS NULL OR "interventionId" IS NOT NULL)
  ) NOT VALID;

CREATE INDEX "chantier_notes_intervention_created_idx"
  ON "chantier_notes"("companyId", "interventionId", "createdAt")
  WHERE "interventionId" IS NOT NULL;

CREATE INDEX "chantier_photos_intervention_created_idx"
  ON "chantier_photos"("companyId", "interventionId", "createdAt")
  WHERE "interventionId" IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_intervention_scope_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intervention_chantier TEXT;
  intervention_status TEXT;
BEGIN
  IF NEW."interventionId" IS NULL THEN
    -- Forme N-1 (writer sans la colonne) : traverse intacte, jamais un blocage de rolling.
    RETURN NEW;
  END IF;
  SELECT i."chantierId", i."status" INTO intervention_chantier, intervention_status
    FROM "interventions" i
   WHERE i."id" = NEW."interventionId"
     AND i."companyId" = NEW."companyId";
  IF intervention_chantier IS NULL THEN
    RAISE EXCEPTION 'INTERVENTION_SCOPE_UNKNOWN_INTERVENTION'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_scope_coherence';
  END IF;
  IF intervention_chantier <> NEW."chantierId" THEN
    RAISE EXCEPTION 'INTERVENTION_SCOPE_CHANTIER_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_scope_coherence';
  END IF;
  -- §3.4 — après la signature, la fiche est une PREUVE : plus aucune trace ne s'y ajoute.
  IF intervention_status = 'signed' THEN
    RAISE EXCEPTION 'INTERVENTION_SIGNED_LOCKED'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_scope_coherence';
  END IF;
  RETURN NEW;
END;
$$;

-- Retrait d'une trace de fiche SIGNÉE : refusé aussi (l'erratum 6 vit AVANT la signature).
CREATE OR REPLACE FUNCTION enforce_intervention_signed_trace_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intervention_status TEXT;
BEGIN
  IF OLD."interventionId" IS NULL THEN
    RETURN OLD;
  END IF;
  SELECT i."status" INTO intervention_status
    FROM "interventions" i
   WHERE i."id" = OLD."interventionId"
     AND i."companyId" = OLD."companyId";
  IF intervention_status = 'signed' THEN
    RAISE EXCEPTION 'INTERVENTION_SIGNED_LOCKED'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_signed_trace_retention';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS intervention_scope_coherence ON "chantier_notes";
CREATE TRIGGER intervention_scope_coherence
BEFORE INSERT OR UPDATE ON "chantier_notes"
FOR EACH ROW
EXECUTE FUNCTION enforce_intervention_scope_coherence();

DROP TRIGGER IF EXISTS intervention_scope_coherence ON "chantier_photos";
CREATE TRIGGER intervention_scope_coherence
BEFORE INSERT OR UPDATE ON "chantier_photos"
FOR EACH ROW
EXECUTE FUNCTION enforce_intervention_scope_coherence();

DROP TRIGGER IF EXISTS intervention_signed_trace_retention ON "chantier_photos";
CREATE TRIGGER intervention_signed_trace_retention
BEFORE DELETE ON "chantier_photos"
FOR EACH ROW
EXECUTE FUNCTION enforce_intervention_signed_trace_retention();

COMMENT ON FUNCTION enforce_intervention_scope_coherence() IS
  'PR-15 : une note/photo taguée fiche vise une fiche du MÊME site et du MÊME tenant, et jamais une fiche signée (verrou §3.4) ; forme N-1 (interventionId NULL) inchangée.';
COMMENT ON FUNCTION enforce_intervention_signed_trace_retention() IS
  'PR-15 : une photo de fiche SIGNÉE ne se retire plus (la séquence erratum 6 vit avant la signature).';

COMMIT;
