-- Coffre documentaire — clôture des capacités runtime sur les originaux.
--
-- Les versions sont append-only. La ligne `documents` conserve des métadonnées éditables
-- (libellé, dossier, tags, validation, révision), mais ses faits d'origine ne peuvent jamais
-- être réécrits. Pour les pièces légales générées, le rattachement et l'état restent eux aussi
-- figés ; une purge après rétention relève d'une capacité d'administration séparée, pas d'un
-- UPDATE/DELETE du rôle applicatif.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION guard_document_original_facts_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  legal_original BOOLEAN :=
    OLD.origin = 'generated'::"StoredDocumentOrigin"
    AND OLD.kind IN (
      'invoice_pdf'::"StoredDocumentKind",
      'facturx_xml'::"StoredDocumentKind",
      'signed_quote'::"StoredDocumentKind"
    );
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
     OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
     OR NEW."documentDate" IS DISTINCT FROM OLD."documentDate"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy" THEN
    RAISE EXCEPTION 'document original facts are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'document_original_facts_immutable';
  END IF;

  IF legal_original AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
    OR NEW."linkedEntityType" IS DISTINCT FROM OLD."linkedEntityType"
    OR NEW."linkedEntityId" IS DISTINCT FROM OLD."linkedEntityId"
    OR NEW."retentionUntil" < OLD."retentionUntil"
  ) THEN
    RAISE EXCEPTION 'legal document archive facts are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'legal_document_archive_facts_immutable';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_document_original_facts_v1() FROM PUBLIC;

CREATE TRIGGER documents_original_facts_immutable
BEFORE UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION guard_document_original_facts_v1();

CREATE FUNCTION guard_document_version_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Compatibilité rolling N-1 : l'ancien adaptateur utilisait UPSERT avec une branche UPDATE
  -- strictement identique pour confirmer un retry. PostgreSQL exécute tout de même le trigger ;
  -- autoriser ce no-op exact préserve l'append-only sans casser les reprises en vol.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document versions are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'document_versions_immutable';
END;
$$;

REVOKE ALL ON FUNCTION guard_document_version_immutable_v1() FROM PUBLIC;

CREATE TRIGGER document_versions_immutable
BEFORE UPDATE ON document_versions
FOR EACH ROW
EXECUTE FUNCTION guard_document_version_immutable_v1();

-- Les projets Supabase peuvent avoir des default privileges accordant EXECUTE directement aux
-- rôles Data API. Le REVOKE PUBLIC ci-dessus ne retire pas ces ACL explicites : les fermer dans la
-- migration source supprime toute fenêtre d'appel RPC avant la clôture globale 1342.
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_document_original_facts_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_document_version_immutable_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
