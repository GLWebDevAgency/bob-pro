-- M2-A-0 — cutover des CHECK catalogue. Feature flag toujours OFF.
-- Les contraintes validées deviennent les noms canoniques sans réécrire les lignes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $bob_catalogue_m2a_cutover_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'catalogue_prestations'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'CATALOGUE_M2A_CUTOVER_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;
END;
$bob_catalogue_m2a_cutover_owner$;

ALTER TABLE public.catalogue_prestations
  DROP CONSTRAINT catalogue_prestations_category_check,
  DROP CONSTRAINT catalogue_prestations_vat_check;

ALTER TABLE public.catalogue_prestations
  RENAME CONSTRAINT catalogue_prestations_category_check_m2a
  TO catalogue_prestations_category_check;
ALTER TABLE public.catalogue_prestations
  RENAME CONSTRAINT catalogue_prestations_vat_check_m2a
  TO catalogue_prestations_vat_check;

RESET ROLE;

COMMIT;
