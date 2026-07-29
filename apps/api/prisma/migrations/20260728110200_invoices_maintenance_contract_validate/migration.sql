-- PR-12b — validation SÉPARÉE de la FK composite posée NOT VALID par 20260728110100
-- (leçon release 25/07 : NOT VALID → VALIDATE en deux migrations, le scan de validation ne
-- bloque pas les écritures concurrentes sous SHARE UPDATE EXCLUSIVE).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_maintenance_contract_company_fkey";

COMMIT;
