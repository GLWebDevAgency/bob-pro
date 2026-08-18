-- Archive V2 — rompt le cycle RLS document -> version -> attestation sans élargir la lecture.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- La lecture profonde doit être possédée par l'owner BYPASSRLS effectif des documents. Il peut
-- être distinct de l'owner des versions et des tables privées Archive. Supabase ne rend pas son
-- déployeur superuser : prendre explicitement ce rôle et ne lui accorder CREATE sur public que
-- pendant la création de cette fonction.
DO $document_version_parent_fence_owner$
DECLARE
  document_owner_oid OID;
  document_owner_name TEXT;
  document_owner_can_bypass_rls BOOLEAN;
  owner_had_schema_create BOOLEAN;
BEGIN
  SELECT relation.relowner,
         pg_catalog.pg_get_userbyid(relation.relowner),
         owner.rolsuper OR owner.rolbypassrls
    INTO STRICT document_owner_oid, document_owner_name, document_owner_can_bypass_rls
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
   WHERE relation.oid = 'public.documents'::regclass;

  IF NOT document_owner_can_bypass_rls THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_DOCUMENT_OWNER_CANNOT_BYPASS_RLS';
  END IF;

  owner_had_schema_create := pg_catalog.has_schema_privilege(
    document_owner_oid,
    'public',
    'CREATE'
  );
  PERFORM pg_catalog.set_config(
    'bob.document_version_parent_fence_owner_had_schema_create',
    CASE WHEN owner_had_schema_create THEN 'true' ELSE 'false' END,
    true
  );

  IF NOT owner_had_schema_create THEN
    EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA public TO %I', document_owner_name);
  END IF;
  IF NOT pg_catalog.has_schema_privilege(document_owner_oid, 'public', 'CREATE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_SCHEMA_CREATE_UNAVAILABLE';
  END IF;

  IF current_user::pg_catalog.regrole <> document_owner_oid THEN
    IF document_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, document_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_DOCUMENT_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', document_owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> document_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_DOCUMENT_OWNER_NOT_ASSUMED';
  END IF;
END;
$document_version_parent_fence_owner$;

CREATE FUNCTION public.document_version_parent_belongs_to_current_tenant_v1(
  expected_document_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $document_version_parent_belongs_to_current_tenant_v1$
DECLARE
  expected_company_id TEXT := nullif(
    current_setting('app.current_company_id', true),
    ''
  );
BEGIN
  IF expected_company_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.documents AS document
     WHERE document.id = expected_document_id
       AND document."companyId" = expected_company_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$document_version_parent_belongs_to_current_tenant_v1$;

REVOKE ALL ON FUNCTION public.document_version_parent_belongs_to_current_tenant_v1(TEXT)
  FROM PUBLIC;
DO $document_version_parent_fence_data_api$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION '
        'public.document_version_parent_belongs_to_current_tenant_v1(TEXT) FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$document_version_parent_fence_data_api$;

-- Une migration et la reconstruction globale des ACL ne sont pas atomiques entre elles. Pour
-- qu'un échec de release après `prisma migrate deploy` ne coupe pas les uploads, préserver dans
-- CETTE transaction l'EXECUTE de chaque writer qui possède déjà explicitement INSERT sur
-- document_versions. La reconstruction de release réduit ensuite l'inventaire au seul app_role.
DO $document_version_parent_fence_existing_writers$
DECLARE
  writer RECORD;
BEGIN
  FOR writer IN
    SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
      JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
     WHERE relation.oid = 'public.document_versions'::regclass
       AND privilege.privilege_type = 'INSERT'
       AND privilege.grantee <> relation.relowner
       AND grantee_role.rolname <> ALL(
         ARRAY['anon', 'authenticated', 'service_role']::TEXT[]
       )
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION '
      'public.document_version_parent_belongs_to_current_tenant_v1(TEXT) TO %I',
      writer.rolname
    );
  END LOOP;
END;
$document_version_parent_fence_existing_writers$;

RESET ROLE;

-- `document_versions` est une table historique qui peut conserver un owner distinct de
-- l'autorité Archive sur Supabase. Le déployeur n'est pas supposé superuser : prendre l'owner
-- exact de la relation avant de remplacer sa policy, même si cet owner diffère de celui de la
-- fonction SECURITY DEFINER créée ci-dessus.
DO $document_version_parent_fence_policy_owner$
DECLARE
  policy_owner_oid OID;
  policy_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT policy_owner_oid, policy_owner_name
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.document_versions'::regclass;

  IF current_user::pg_catalog.regrole <> policy_owner_oid THEN
    IF policy_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, policy_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_POLICY_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', policy_owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> policy_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_POLICY_OWNER_NOT_ASSUMED';
  END IF;
END;
$document_version_parent_fence_policy_owner$;

DROP POLICY IF EXISTS tenant_document_version_insert ON public.document_versions;
CREATE POLICY tenant_document_version_insert ON public.document_versions
  FOR INSERT
  WITH CHECK (
    public.document_version_parent_belongs_to_current_tenant_v1("documentId")
  );

RESET ROLE;

DO $document_version_parent_fence_owner_restore$
DECLARE
  document_owner_oid OID;
  document_owner_name TEXT;
  owner_had_schema_create BOOLEAN := coalesce(
    current_setting('bob.document_version_parent_fence_owner_had_schema_create', true),
    ''
  ) = 'true';
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT document_owner_oid, document_owner_name
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.documents'::regclass;

  IF NOT owner_had_schema_create THEN
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', document_owner_name);
    IF pg_catalog.has_schema_privilege(document_owner_oid, 'public', 'CREATE')
       OR NOT pg_catalog.has_schema_privilege(document_owner_oid, 'public', 'USAGE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DOCUMENT_VERSION_PARENT_FENCE_SCHEMA_ACL_RESTORE_FAILED';
    END IF;
  END IF;
END;
$document_version_parent_fence_owner_restore$;

COMMIT;
