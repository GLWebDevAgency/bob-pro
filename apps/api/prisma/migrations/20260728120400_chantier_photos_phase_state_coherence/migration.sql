-- [Revue adversariale 28/07 — finding 6] PHASE avant/après ↔ MACHINE À ÉTATS (§3.3).
--
-- La phase n'est pas une étiquette libre : c'est une AFFIRMATION DATÉE portée par une pièce de
-- preuve (« voici l'état AVANT mon travail »). Le use case la tenait déjà (Clean Arch), la base
-- la re-vérifie — comme elle re-vérifie le verrou post-signature §3.4 :
--   • `before` sur une fiche déjà `completed` : l'état initial n'existe plus, la photo
--     affirmerait ce qu'elle ne peut plus montrer ;
--   • `after` sur une fiche encore `scheduled` : il n'y a aucun travail à montrer.
--
-- Ce que ce trigger N'INTERDIT PAS, volontairement :
--   • la séquence terrain §3.6 (file FIFO photos → complete → sign) : les deux phases s'insèrent
--     pendant `in_progress`, et une « après » reste acceptée sur une fiche `completed` ;
--   • la photo SANS phase (le chemin qui ne perd aucune preuve quand le refus tombe) ;
--   • la forme N-1 (writer sans les colonnes du train) : elle traverse intacte.
-- Le verrou `signed` et l'existence de la fiche restent tenus par intervention_scope_coherence
-- (déclenché APRÈS celui-ci — ordre alphabétique des triggers BEFORE ROW) : les messages de
-- refus déjà certifiés ne changent pas.
--
-- Aucun ALTER TABLE, aucune réécriture : la migration ne pose qu'une fonction et un trigger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION enforce_intervention_photo_phase_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intervention_status TEXT;
BEGIN
  -- Photo de site, ou forme N-1 : rien à vérifier ici.
  IF NEW."phase" IS NULL OR NEW."interventionId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT i."status" INTO intervention_status
    FROM "interventions" i
   WHERE i."id" = NEW."interventionId"
     AND i."companyId" = NEW."companyId";
  -- Fiche inconnue : c'est intervention_scope_coherence qui le dit (une seule règle, un seul
  -- message) — ce trigger ne double jamais un refus déjà porté ailleurs.
  IF intervention_status IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."phase" = 'before' AND intervention_status = 'completed' THEN
    RAISE EXCEPTION 'INTERVENTION_PHASE_BEFORE_AFTER_COMPLETION'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_photo_phase_coherence';
  END IF;
  IF NEW."phase" = 'after' AND intervention_status = 'scheduled' THEN
    RAISE EXCEPTION 'INTERVENTION_PHASE_AFTER_BEFORE_START'
      USING ERRCODE = '23514', CONSTRAINT = 'intervention_photo_phase_coherence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intervention_photo_phase_coherence ON "chantier_photos";
CREATE TRIGGER intervention_photo_phase_coherence
BEFORE INSERT OR UPDATE ON "chantier_photos"
FOR EACH ROW
EXECUTE FUNCTION enforce_intervention_photo_phase_coherence();

COMMENT ON FUNCTION enforce_intervention_photo_phase_coherence() IS
  'PR-15 (finding 6) : la phase avant/après d''une photo est cohérente avec la machine à états — « avant » jamais après la complétion, « après » jamais avant le démarrage ; photo sans phase et forme N-1 intactes.';

COMMIT;
