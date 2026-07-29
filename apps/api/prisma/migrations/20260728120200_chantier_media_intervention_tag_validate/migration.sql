-- PR-15b — validation SÉPARÉE des contraintes posées NOT VALID par
-- 20260728120100_chantier_media_intervention_tag (leçon release 25/07 : le VALIDATE ne prend
-- qu'un verrou léger, compatible writers N-1 ; toutes les lignes existantes ont interventionId
-- et phase NULL, la passe est triviale).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "chantier_notes"
  VALIDATE CONSTRAINT "chantier_notes_intervention_company_fkey";

ALTER TABLE "chantier_notes"
  VALIDATE CONSTRAINT "chantier_notes_intervention_id_check";

ALTER TABLE "chantier_photos"
  VALIDATE CONSTRAINT "chantier_photos_intervention_company_fkey";

ALTER TABLE "chantier_photos"
  VALIDATE CONSTRAINT "chantier_photos_intervention_id_check";

ALTER TABLE "chantier_photos"
  VALIDATE CONSTRAINT "chantier_photos_phase_check";

COMMIT;
