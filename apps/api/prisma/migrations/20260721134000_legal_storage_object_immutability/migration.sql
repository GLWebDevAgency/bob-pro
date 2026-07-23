-- Les octets Supabase d'une pièce légale sont aussi immuables que leur ligne SQL.
-- Le trigger est installé lorsque le schéma vendor Storage existe (production/Supabase).
-- Les bases de tooling sans Supabase peuvent appliquer la migration ; release.sh refuse en
-- revanche tout environnement de livraison où le trigger n'est pas réellement attaché.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION public.prevent_generated_legal_storage_object_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  old_key TEXT := OLD.name;
  new_key TEXT := CASE WHEN TG_OP = 'UPDATE' THEN NEW.name ELSE NULL END;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.documents AS document
     WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
       AND document.kind IN (
         'invoice_pdf'::public."StoredDocumentKind",
         'facturx_xml'::public."StoredDocumentKind",
         'signed_quote'::public."StoredDocumentKind"
       )
       AND document."storageKey" IN (old_key, new_key)
  ) THEN
    RAISE EXCEPTION 'generated legal storage objects are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_legal_storage_object_immutable';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_generated_legal_storage_object_mutation() FROM PUBLIC;
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'public.prevent_generated_legal_storage_object_mutation() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS generated_legal_storage_object_immutable ON storage.objects;
    CREATE TRIGGER generated_legal_storage_object_immutable
    BEFORE UPDATE OR DELETE ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION public.prevent_generated_legal_storage_object_mutation();
  END IF;
END;
$$;

COMMENT ON FUNCTION public.prevent_generated_legal_storage_object_mutation() IS
  'Fail-closed fence: blocks UPDATE/DELETE of Supabase objects referenced as generated legal originals.';

COMMIT;
