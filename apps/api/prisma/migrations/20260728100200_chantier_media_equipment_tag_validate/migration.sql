-- PR-11b — validation SÉPARÉE des contraintes posées NOT VALID par
-- 20260728100100_chantier_media_equipment_tag (leçon release 25/07 : le VALIDATE ne prend
-- qu'un verrou léger, compatible writers N-1 ; toutes les lignes existantes ont
-- equipmentId NULL, la passe est triviale).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "chantier_notes"
  VALIDATE CONSTRAINT "chantier_notes_equipment_company_fkey";

ALTER TABLE "chantier_notes"
  VALIDATE CONSTRAINT "chantier_notes_equipment_id_check";

ALTER TABLE "chantier_photos"
  VALIDATE CONSTRAINT "chantier_photos_equipment_company_fkey";

ALTER TABLE "chantier_photos"
  VALIDATE CONSTRAINT "chantier_photos_equipment_id_check";

COMMIT;
