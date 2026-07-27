-- PR-08 — validation SÉPARÉE des contraintes posées NOT VALID par
-- 20260727100000_pieces_chantier_scope (leçon release 25/07 : le VALIDATE ne prend qu'un
-- verrou léger, compatible avec les writers N-1 ; toutes les lignes existantes ont
-- chantierId NULL, la passe est triviale).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "quotes"
  VALIDATE CONSTRAINT "quotes_chantier_company_fkey";

ALTER TABLE "quotes"
  VALIDATE CONSTRAINT "quotes_chantier_id_check";

ALTER TABLE "invoices"
  VALIDATE CONSTRAINT "invoices_chantier_company_fkey";

ALTER TABLE "invoices"
  VALIDATE CONSTRAINT "invoices_chantier_id_check";

COMMIT;
