#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${APP_DATABASE_ROLE:?APP_DATABASE_ROLE non-superuser runtime role is required}"
: "${DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA:?40-char release SHA is required}"
: "${SUPABASE_STORAGE_BUCKET:?SUPABASE_STORAGE_BUCKET canonical runtime bucket is required}"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required to certify migration checksums" >&2
  exit 1
}

case "$DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA" in
  *[!0-9a-f]*|'')
    echo "DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA must be a lowercase hexadecimal SHA" >&2
    exit 1
    ;;
esac
if [ "${#DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA}" -ne 40 ]; then
  echo "DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA must contain exactly 40 characters" >&2
  exit 1
fi
case "$SUPABASE_STORAGE_BUCKET" in
  *[!a-z0-9._-]*|'')
    echo "SUPABASE_STORAGE_BUCKET must be a lowercase canonical bucket identifier" >&2
    exit 1
    ;;
esac
case "$SUPABASE_STORAGE_BUCKET" in
  [a-z0-9]*) ;;
  *)
    echo "SUPABASE_STORAGE_BUCKET must start with a lowercase letter or digit" >&2
    exit 1
    ;;
esac
if [ "${#SUPABASE_STORAGE_BUCKET}" -gt 63 ]; then
  echo "SUPABASE_STORAGE_BUCKET must contain at most 63 characters" >&2
  exit 1
fi

document_archive_migration_checksum() {
  migration_name="$1"
  migration_file="apps/api/prisma/migrations/$migration_name/migration.sql"
  if [ ! -f "$migration_file" ]; then
    echo "document archive migration file is missing: $migration_name" >&2
    return 1
  fi

  checksum="$(openssl dgst -sha256 -r "$migration_file" | awk '{print $1}')"
  case "$checksum" in
    *[!0-9a-f]*|'')
      echo "cannot compute a canonical SHA-256 for migration: $migration_name" >&2
      return 1
      ;;
  esac
  if [ "${#checksum}" -ne 64 ]; then
    echo "cannot compute a canonical SHA-256 for migration: $migration_name" >&2
    return 1
  fi

  printf '%s' "$checksum"
}

migration_1332_sha256="$(document_archive_migration_checksum \
  20260721133200_document_archive_integrity_proof)"
migration_1333_sha256="$(document_archive_migration_checksum \
  20260721133300_document_original_retention_fences)"
migration_1335_sha256="$(document_archive_migration_checksum \
  20260721133500_document_archive_db_closure)"
migration_1337_sha256="$(document_archive_migration_checksum \
  20260721133700_document_archive_customer_scope_fence)"
migration_1338_sha256="$(document_archive_migration_checksum \
  20260721133800_document_archive_rollout_protocol)"
migration_1339_sha256="$(document_archive_migration_checksum \
  20260721133900_document_archive_audit_evidence)"
migration_1340_sha256="$(document_archive_migration_checksum \
  20260721134000_legal_storage_object_immutability)"
migration_1341_sha256="$(document_archive_migration_checksum \
  20260721134100_document_archive_private_report)"
migration_1342_sha256="$(document_archive_migration_checksum \
  20260721134200_document_archive_data_api_fence)"

# Le lock, l'audit, la réconciliation bornée, le backfill, le CAS de protocole et les ACL
# forment une seule transaction. Toute anomalie remet donc intégralement la base dans l'état V1.
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v app_role="$APP_DATABASE_ROLE" \
  -v release_sha="$DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA" \
  -v storage_bucket="$SUPABASE_STORAGE_BUCKET" \
  -v migration_1332_sha256="$migration_1332_sha256" \
  -v migration_1333_sha256="$migration_1333_sha256" \
  -v migration_1335_sha256="$migration_1335_sha256" \
  -v migration_1337_sha256="$migration_1337_sha256" \
  -v migration_1338_sha256="$migration_1338_sha256" \
  -v migration_1339_sha256="$migration_1339_sha256" \
  -v migration_1340_sha256="$migration_1340_sha256" \
  -v migration_1341_sha256="$migration_1341_sha256" \
  -v migration_1342_sha256="$migration_1342_sha256" <<'SQL'
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';
SET LOCAL idle_in_transaction_session_timeout = '310s';

-- Les variables psql ont été validées côté shell. La valeur du SHA est copiée dans un
-- paramètre transactionnel, car psql ne substitue volontairement rien dans les blocs $$.
SELECT set_config('bob.document_archive_activation_release_sha', :'release_sha', true);
SELECT set_config('bob.document_archive_activation_app_role', :'app_role', true);
SELECT set_config('bob.document_archive_activation_storage_bucket', :'storage_bucket', true);
SELECT set_config('bob.document_archive_migration_1332_sha256', :'migration_1332_sha256', true);
SELECT set_config('bob.document_archive_migration_1333_sha256', :'migration_1333_sha256', true);
SELECT set_config('bob.document_archive_migration_1335_sha256', :'migration_1335_sha256', true);
SELECT set_config('bob.document_archive_migration_1337_sha256', :'migration_1337_sha256', true);
SELECT set_config('bob.document_archive_migration_1338_sha256', :'migration_1338_sha256', true);
SELECT set_config('bob.document_archive_migration_1339_sha256', :'migration_1339_sha256', true);
SELECT set_config('bob.document_archive_migration_1340_sha256', :'migration_1340_sha256', true);
SELECT set_config('bob.document_archive_migration_1341_sha256', :'migration_1341_sha256', true);
SELECT set_config('bob.document_archive_migration_1342_sha256', :'migration_1342_sha256', true);

-- Le checksum n'est pas un préflight best-effort : les lignes Prisma restent verrouillées jusqu'au
-- COMMIT du cutover, afin qu'aucune réécriture concurrente ne puisse créer une fenêtre TOCTOU.
LOCK TABLE public._prisma_migrations IN SHARE MODE;

DO $$
DECLARE
  runtime_role RECORD;
  direct_authority RECORD;
  evidence_relation RECORD;
  private_relation RECORD;
  private_table TEXT;
  expected_archive_function_names CONSTANT TEXT[] := ARRAY[
    'attest_generated_invoice_pdf_v1',
    'attest_historical_generated_invoice_pdf_v1',
    'capture_invoice_archive_audience_v1',
    'document_archive_backfill_proved_artifacts_v1',
    'document_archive_integrity_proof_for_reason_v2_is_valid',
    'document_archive_integrity_proof_v1_is_valid',
    'document_archive_integrity_proof_v1_sha256',
    'document_archive_job_claim_v1',
    'document_archive_job_complete_v1',
    'document_archive_job_complete_v2',
    'document_archive_job_enqueue_v1',
    'document_archive_job_enqueue_v2',
    'document_archive_job_fail_v1',
    'document_archive_job_pdf_attestation_v2_is_valid',
    'document_archive_job_scope_v2_is_valid',
    'document_archive_protocol_v2_is_active',
    'enforce_document_archive_audit_evidence_immutable',
    'enforce_document_archive_protocol_monotonicity',
    'generated_invoice_pdf_attestation_visible_v2',
    'generated_legal_archive_representation_v2_is_valid',
    'guard_customer_type_after_legal_piece_v1',
    'guard_document_archive_job_proof_v1',
    'guard_document_archive_job_scope_v2',
    'guard_document_invoice_pdf_attestation_immutable_v1',
    'guard_document_original_facts_v1',
    'guard_document_version_immutable_v1',
    'guard_generated_invoice_facturx_scope_v1',
    'guard_generated_legal_archive_cutover_v2',
    'guard_generated_legal_archive_representation_v2',
    'prevent_generated_legal_storage_object_mutation',
    'spool_document_archive_job_during_v2_cutover'
  ]::TEXT[];
  archive_function RECORD;
  archive_function_count INTEGER;
  exposed_role TEXT;
  migration_drift TEXT;
BEGIN
  SELECT string_agg(
           expected.migration_name || ' (' ||
           CASE
             WHEN applied.applied_count = 0 THEN 'not applied'
             WHEN applied.applied_count > 1 THEN 'multiple active rows'
             ELSE 'checksum mismatch'
           END || ')',
           ', ' ORDER BY expected.migration_name
         )
    INTO migration_drift
    FROM (
      VALUES
        (
          '20260721133200_document_archive_integrity_proof',
          current_setting('bob.document_archive_migration_1332_sha256')
        ),
        (
          '20260721133300_document_original_retention_fences',
          current_setting('bob.document_archive_migration_1333_sha256')
        ),
        (
          '20260721133500_document_archive_db_closure',
          current_setting('bob.document_archive_migration_1335_sha256')
        ),
        (
          '20260721133700_document_archive_customer_scope_fence',
          current_setting('bob.document_archive_migration_1337_sha256')
        ),
        (
          '20260721133800_document_archive_rollout_protocol',
          current_setting('bob.document_archive_migration_1338_sha256')
        ),
        (
          '20260721133900_document_archive_audit_evidence',
          current_setting('bob.document_archive_migration_1339_sha256')
        ),
        (
          '20260721134000_legal_storage_object_immutability',
          current_setting('bob.document_archive_migration_1340_sha256')
        ),
        (
          '20260721134100_document_archive_private_report',
          current_setting('bob.document_archive_migration_1341_sha256')
        ),
        (
          '20260721134200_document_archive_data_api_fence',
          current_setting('bob.document_archive_migration_1342_sha256')
        )
    ) AS expected(migration_name, checksum)
    CROSS JOIN LATERAL (
      SELECT count(*)::INTEGER AS applied_count,
             min(migration.checksum) AS checksum
        FROM public._prisma_migrations AS migration
       WHERE migration.migration_name = expected.migration_name
         AND migration.finished_at IS NOT NULL
         AND migration.rolled_back_at IS NULL
    ) AS applied
   WHERE applied.applied_count <> 1
      OR applied.checksum IS DISTINCT FROM expected.checksum;

  IF migration_drift IS NOT NULL THEN
    RAISE EXCEPTION
      'document archive V2 migration set is incomplete or divergent: %', migration_drift;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc AS function ON function.oid = trigger.tgfoid
      JOIN pg_catalog.pg_roles AS function_owner ON function_owner.oid = function.proowner
     WHERE namespace.nspname = 'storage'
       AND relation.relname = 'objects'
       AND trigger.tgname = 'generated_legal_storage_object_immutable'
       AND NOT trigger.tgisinternal
       AND trigger.tgenabled = 'O'
       AND function.proname = 'prevent_generated_legal_storage_object_mutation'
       AND function.prosecdef
       AND function.proconfig @> ARRAY['row_security=off']::TEXT[]
       AND (function_owner.rolsuper OR function_owner.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'generated legal Storage immutability trigger is missing';
  END IF;

  SELECT rolname, rolsuper, rolbypassrls
    INTO runtime_role
    FROM pg_catalog.pg_roles
   WHERE rolname = current_setting('bob.document_archive_activation_app_role');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_DATABASE_ROLE does not exist';
  END IF;
  IF runtime_role.rolsuper OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'APP_DATABASE_ROLE must be NOSUPERUSER and NOBYPASSRLS';
  END IF;

  SELECT rolsuper, rolbypassrls
    INTO STRICT direct_authority
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF NOT (direct_authority.rolsuper OR direct_authority.rolbypassrls) THEN
    RAISE EXCEPTION
      'DIRECT_URL role must be SUPERUSER or BYPASSRLS for private archive evidence';
  END IF;

  SELECT relation.oid, relation.relacl, relation.relowner,
         relation.relrowsecurity, relation.relforcerowsecurity
    INTO STRICT evidence_relation
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'document_archive_audit_evidence'
     AND relation.relkind = 'r';

  IF NOT evidence_relation.relrowsecurity OR NOT evidence_relation.relforcerowsecurity THEN
    RAISE EXCEPTION 'document archive evidence must have ENABLE + FORCE RLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = evidence_relation.oid
  ) THEN
    RAISE EXCEPTION 'document archive evidence must not expose any RLS policy';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.aclexplode(
        coalesce(
          evidence_relation.relacl,
          pg_catalog.acldefault('r', evidence_relation.relowner)
        )
      ) AS privilege
     WHERE privilege.grantee = 0
       AND privilege.privilege_type IN (
         'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       )
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains a privilege on document archive evidence';
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND pg_catalog.has_table_privilege(
         exposed_role,
         'public.document_archive_audit_evidence',
         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
       ) THEN
      RAISE EXCEPTION '% retains a privilege on document archive evidence', exposed_role;
    END IF;
  END LOOP;

  FOREACH private_table IN ARRAY ARRAY[
    'document_archive_job_artifacts',
    'document_invoice_pdf_attestations'
  ]::TEXT[] LOOP
    SELECT relation.oid, relation.relacl, relation.relowner,
           relation.relrowsecurity, relation.relforcerowsecurity
      INTO STRICT private_relation
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = private_table
       AND relation.relkind = 'r';
    IF NOT private_relation.relrowsecurity OR NOT private_relation.relforcerowsecurity THEN
      RAISE EXCEPTION '% must have ENABLE + FORCE RLS', private_table;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.aclexplode(
          coalesce(private_relation.relacl, pg_catalog.acldefault('r', private_relation.relowner))
        ) AS privilege
       WHERE privilege.grantee = 0
         AND privilege.privilege_type IN (
           'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
         )
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains a privilege on private archive table %', private_table;
    END IF;
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
         AND pg_catalog.has_table_privilege(
           exposed_role,
           pg_catalog.format('public.%I', private_table),
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
         ) THEN
        RAISE EXCEPTION '% retains a privilege on private archive table %',
          exposed_role, private_table;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS privilege
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'document_archive_protocol_state'
       AND privilege.grantee = 0
       AND privilege.privilege_type IN (
         'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       )
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains a mutation privilege on document archive protocol state';
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND pg_catalog.has_table_privilege(
         exposed_role,
         'public.document_archive_protocol_state',
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
       ) THEN
      RAISE EXCEPTION '% retains a mutation privilege on document archive protocol state',
        exposed_role;
    END IF;
  END LOOP;

  SELECT count(*)::INTEGER
    INTO archive_function_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.prokind = 'f'
     AND procedure.proname = ANY(expected_archive_function_names);
  IF archive_function_count <> cardinality(expected_archive_function_names) THEN
    RAISE EXCEPTION
      'archive RPC inventory drift: expected %, found %',
      cardinality(expected_archive_function_names), archive_function_count;
  END IF;
  FOR archive_function IN
    SELECT procedure.oid, procedure.proacl, procedure.proowner, procedure.proname
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.prokind = 'f'
       AND procedure.proname = ANY(expected_archive_function_names)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.aclexplode(
          coalesce(
            archive_function.proacl,
            pg_catalog.acldefault('f', archive_function.proowner)
          )
        ) AS privilege
       WHERE privilege.grantee = 0
         AND privilege.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains EXECUTE on archive RPC %', archive_function.proname;
    END IF;
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
         AND pg_catalog.has_function_privilege(exposed_role, archive_function.oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% retains EXECUTE on archive RPC %',
          exposed_role, archive_function.proname;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- L'ordre est stable et suit le graphe métier : sources légales, ordres, puis preuves. Le mode
-- SHARE ROW EXCLUSIVE laisse les lectures vivre mais attend/empêche tout writer N ou N-1.
-- Le singleton passe en premier : le scanner historique prend ce même verrou avant les documents,
-- ce qui sérialise strictement son lot d'attestations avec le CAS V1 -> V2 sans deadlock inversé.
SELECT pg_advisory_xact_lock(hashtextextended('bob-document-archive-byte-audit', 0));
SELECT "activeVersion"
  FROM public.document_archive_protocol_state
 WHERE id = 1
 FOR UPDATE;
-- Les writers déposent d'abord l'objet puis matérialisent sa ligne SQL. Prendre Storage avant les
-- tables métier suit ce même ordre et évite un cycle de verrouillage avec un upload déjà engagé.
-- Le trigger 1340 prend ensuite le relais de manière permanente sur UPDATE/DELETE.
LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_versions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.chantier_photos IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_invoice_pdf_attestations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_version SMALLINT;
  changed_rows BIGINT;
BEGIN
  SELECT "activeVersion"
    INTO STRICT current_version
    FROM public.document_archive_protocol_state
   WHERE id = 1;

  IF current_version NOT IN (1, 2) THEN
    RAISE EXCEPTION 'unexpected document archive protocol version: %', current_version;
  END IF;

  -- Inventaire bidirectionnel refait SOUS les verrous Storage + SQL. Il ferme la dernière fenêtre
  -- entre le second snapshot du scanner et ce CAS : aucun upload orphelin ni référence dont les
  -- octets ont disparu ne peut être consacré par l'activation.
  IF EXISTS (
    SELECT 1
      FROM storage.objects AS object
     WHERE object.bucket_id = current_setting('bob.document_archive_activation_storage_bucket')
       AND (
         object.name LIKE 'companies/%/documents/%'
         OR object.name LIKE 'companies/%/chantiers/%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.documents AS document
          WHERE document."storageKey" = object.name
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.document_versions AS version
          WHERE version."storageKey" = object.name
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.chantier_photos AS photo
          WHERE photo."storageKey" = object.name
       )
  ) THEN
    RAISE EXCEPTION 'Storage orphan appeared after the archive audit';
  END IF;

  IF EXISTS (
    WITH referenced_objects AS (
      SELECT document."storageKey" AS storage_key FROM public.documents AS document
      UNION
      SELECT version."storageKey" AS storage_key FROM public.document_versions AS version
      UNION
      SELECT photo."storageKey" AS storage_key FROM public.chantier_photos AS photo
    )
    SELECT 1
      FROM referenced_objects AS reference
     WHERE NOT EXISTS (
       SELECT 1
         FROM storage.objects AS object
        WHERE object.bucket_id = current_setting('bob.document_archive_activation_storage_bucket')
          AND object.name = reference.storage_key
     )
  ) THEN
    RAISE EXCEPTION 'SQL reference without Storage object appeared after the archive audit';
  END IF;

  IF current_version = 1 AND NOT EXISTS (
    SELECT 1
      FROM public.document_archive_audit_evidence AS evidence
      JOIN public.document_archive_protocol_state AS protocol
        ON protocol.id = 1
       AND protocol."databaseIdentity" = evidence."databaseIdentity"
     WHERE btrim(evidence."releaseSha"::text) =
             current_setting('bob.document_archive_activation_release_sha')
       AND evidence."storageBucket" =
             current_setting('bob.document_archive_activation_storage_bucket')
       AND evidence."protocolVersion" = 1
       AND evidence.mode = 'apply-attestations'
       AND evidence."readyForActivation"
       AND jsonb_typeof(evidence.counts) = 'object'
       AND CASE
         WHEN evidence.counts->>'p0Issues' ~ '^[0-9]+$'
           THEN (evidence.counts->>'p0Issues')::integer = 0
         ELSE FALSE
       END
       -- La preuve byte-derived est un snapshot. Tout original légal créé ou remplacé après son
       -- horodatage invalide le cutover et impose un nouveau scan ; aucune fenêtre TOCTOU n'est
       -- maquillée par le seul fait que les métadonnées SQL restent cohérentes.
       AND NOT EXISTS (
         SELECT 1
           FROM public.documents AS document
           LEFT JOIN public.document_versions AS version
             ON version."documentId" = document.id
            AND version.version = 1
          WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
            AND document.kind IN (
              'invoice_pdf'::public."StoredDocumentKind",
              'facturx_xml'::public."StoredDocumentKind",
              'signed_quote'::public."StoredDocumentKind"
            )
            AND (
              document."createdAt" > evidence."auditedAt"
              OR version.id IS NULL
              OR version."createdAt" > evidence."auditedAt"
              OR NOT EXISTS (
                SELECT 1
                  FROM storage.objects AS object
                 WHERE object.bucket_id = evidence."storageBucket"
                   AND object.name = document."storageKey"
                   AND object.created_at <= evidence."auditedAt"
                   AND object.updated_at <= evidence."auditedAt"
              )
            )
       )
  ) THEN
    RAISE EXCEPTION
      'document archive activation refused: no successful byte-audit evidence for this release'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_activation_release_audit_evidence';
  END IF;

  -- Aucun calcul a posteriori depuis la fiche client n'est admis. Une facture legacy émise dont
  -- l'audience n'a pas été établie par une preuve auditée bloque le train entier.
  IF EXISTS (
    SELECT 1
      FROM public.invoices AS invoice
     WHERE invoice.number IS NOT NULL
       AND invoice."issuedAt" IS NOT NULL
       AND invoice.status <> 'draft'::public."InvoiceStatus"
       AND (
         invoice."archiveAudienceAtIssuance" IS NULL
         OR invoice."archiveAudienceAtIssuance" NOT IN ('consumer', 'professional')
       )
  ) THEN
    RAISE EXCEPTION
      'document archive activation refused: an issued invoice has no audited archive audience'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_activation_all_issued_snapshots_known';
  END IF;

  -- Le MIME, le motif de job et le SHA déclaratif ne suffisent pas. Chaque sortie légale générée
  -- doit avoir une version 1 exacte et, pour un PDF facture, l'attestation dérivée de ses octets.
  -- Le helper profond reste inaccessible au runtime ; l'activation l'appelle avec DIRECT_URL.
  IF EXISTS (
    SELECT 1
      FROM public.documents AS document
     WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
       AND document.kind IN (
         'invoice_pdf'::public."StoredDocumentKind",
         'facturx_xml'::public."StoredDocumentKind",
         'signed_quote'::public."StoredDocumentKind"
       )
       AND NOT coalesce(
         public.generated_legal_archive_representation_v2_is_valid(document.id),
         FALSE
       )
  ) THEN
    RAISE EXCEPTION
      'document archive activation refused: a generated legal representation is not V2-attested'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_activation_all_representations_valid';
  END IF;

  IF current_version = 1 THEN
    -- Un ancien worker peut avoir téléversé/matérialisé un XML juste avant l'installation du
    -- fence 1337. Même sans manifeste de job, ce document est une sortie réglementaire indue :
    -- l'activation s'arrête et exige une revue, elle ne le masque ni ne le supprime.
    IF EXISTS (
      SELECT 1
        FROM public.documents AS document
        LEFT JOIN public.invoices AS invoice
          ON invoice.id = document."linkedEntityId"
         AND invoice."companyId" = document."companyId"
       WHERE document.kind = 'facturx_xml'::public."StoredDocumentKind"
         AND document.origin = 'generated'::public."StoredDocumentOrigin"
         AND (
           document."linkedEntityType" IS DISTINCT FROM 'invoice'::public."StoredDocumentLinkedEntityType"
           OR invoice.id IS NULL
           OR invoice."archiveAudienceAtIssuance" IS DISTINCT FROM 'professional'
         )
    ) THEN
      RAISE EXCEPTION
        'document archive activation refused: generated Factur-X XML has no professional issuance scope'
        USING ERRCODE = '23514',
              CONSTRAINT = 'documents_generated_invoice_facturx_scope_valid';
    END IF;

    -- Une archive, un digest ou une date de fin constituent une preuve observable. Une preuve
    -- produite avec le mauvais scope ne peut jamais être réécrite ni masquée automatiquement.
    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS job
       WHERE NOT coalesce(public.document_archive_job_scope_v2_is_valid(
               job."companyId", job."invoiceId", job.reason
             ), false)
         AND (
           job."integrityProof" IS NOT NULL
           OR job."integrityProofSha256" IS NOT NULL
           OR job."completedAt" IS NOT NULL
           OR EXISTS (
             SELECT 1
               FROM public.document_archive_job_artifacts AS artifact
              WHERE artifact."jobId" = job.id
                AND artifact."companyId" = job."companyId"
           )
         )
    ) THEN
      RAISE EXCEPTION
        'document archive activation refused: a proved job has an invalid V2 scope'
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_activation_proved_scope_valid';
    END IF;

    -- Deux anciens jobs non prouvés visant la même facture mais des motifs opposés ne sont pas
    -- fusionnés silencieusement : la contrainte d'unicité doit rester explicable et auditable.
    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS legacy_job
        JOIN public.invoices AS invoice
          ON invoice.id = legacy_job."invoiceId"
         AND invoice."companyId" = legacy_job."companyId"
        JOIN public.document_archive_jobs AS expected_job
          ON expected_job."companyId" = legacy_job."companyId"
         AND expected_job."invoiceId" = legacy_job."invoiceId"
         AND expected_job.id <> legacy_job.id
         AND expected_job.reason = CASE
           WHEN invoice."archiveAudienceAtIssuance" = 'consumer'
             THEN 'invoice-issued-pdf-only-b2c'
           WHEN invoice."archiveAudienceAtIssuance" = 'professional'
             THEN 'invoice-issued'
         END
       WHERE legacy_job.reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c')
         AND invoice."archiveAudienceAtIssuance" IN ('consumer', 'professional')
         AND legacy_job.reason <> CASE
           WHEN invoice."archiveAudienceAtIssuance" = 'consumer'
             THEN 'invoice-issued-pdf-only-b2c'
           ELSE 'invoice-issued'
         END
         AND legacy_job."integrityProof" IS NULL
         AND legacy_job."integrityProofSha256" IS NULL
         AND legacy_job."completedAt" IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.document_archive_job_artifacts AS artifact
            WHERE artifact."jobId" = legacy_job.id
              AND artifact."companyId" = legacy_job."companyId"
         )
    ) THEN
      RAISE EXCEPTION
        'document archive activation refused: conflicting unproved invoice jobs require review'
        USING ERRCODE = '23505',
              CONSTRAINT = 'uniq_document_archive_job';
    END IF;

    -- Seuls les ordres facture sans aucune preuve sont réconciliables. Les devis et toute ligne
    -- orpheline restent inchangés puis font échouer l'audit global ci-dessous.
    UPDATE public.document_archive_jobs AS job
       SET reason = CASE
             WHEN invoice."archiveAudienceAtIssuance" = 'consumer'
               THEN 'invoice-issued-pdf-only-b2c'
             ELSE 'invoice-issued'
           END,
           "leaseToken" = NULL,
           -- Le marqueur `[archive-integrity-proof-required]`, le statut et le compteur de retry
           -- sont des faits d'audit. Le trigger V1 garde le job au sentinel jusqu'au flip.
           "updatedAt" = statement_timestamp()
      FROM public.invoices AS invoice
     WHERE job."invoiceId" = invoice.id
       AND job."companyId" = invoice."companyId"
       AND invoice.number IS NOT NULL
       AND invoice."issuedAt" IS NOT NULL
       AND invoice.status <> 'draft'::public."InvoiceStatus"
       AND invoice."archiveAudienceAtIssuance" IN ('consumer', 'professional')
       AND job.reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c')
       AND job.reason <> CASE
         WHEN invoice."archiveAudienceAtIssuance" = 'consumer'
           THEN 'invoice-issued-pdf-only-b2c'
         ELSE 'invoice-issued'
       END
       AND job."integrityProof" IS NULL
       AND job."integrityProofSha256" IS NULL
       AND job."completedAt" IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.document_archive_job_artifacts AS artifact
          WHERE artifact."jobId" = job.id
            AND artifact."companyId" = job."companyId"
       );
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    RAISE NOTICE 'reconciled % unproved invoice archive job(s)', changed_rows;

    -- Audit exhaustif après réconciliation : source absente, devis non signé, type client
    -- incohérent ou motif inconnu bloquent tous l'activation.
    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS job
       WHERE NOT coalesce(public.document_archive_job_scope_v2_is_valid(
               job."companyId", job."invoiceId", job.reason
             ), false)
    ) THEN
      RAISE EXCEPTION
        'document archive activation refused: at least one job has an invalid V2 scope'
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_activation_all_scopes_valid';
    END IF;

    -- Revérifie les tuples de preuve byte-derived, versions et hashes persistés avant de
    -- matérialiser la projection relationnelle. Les octets Storage ont été relus par l'attesteur.
    PERFORM public.document_archive_backfill_proved_artifacts_v1();

    UPDATE public.document_archive_protocol_state
       SET "activeVersion" = 2,
           "activatedAt" = statement_timestamp(),
           "activatedByReleaseSha" =
             current_setting('bob.document_archive_activation_release_sha'),
           "updatedAt" = statement_timestamp()
     WHERE id = 1
       AND "activeVersion" = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'document archive protocol activation lost its lock';
    END IF;
  ELSE
    -- Une relance idempotente ne réécrit jamais la preuve d'activation. Elle recontrôle
    -- néanmoins les scopes et la projection avant de restaurer les ACL attendues.
    IF EXISTS (
      SELECT 1
        FROM public.document_archive_jobs AS job
       WHERE NOT coalesce(public.document_archive_job_scope_v2_is_valid(
               job."companyId", job."invoiceId", job.reason
             ), false)
    ) THEN
      RAISE EXCEPTION
        'document archive V2 contains a job with an invalid scope'
        USING ERRCODE = '23514',
              CONSTRAINT = 'document_archive_activation_all_scopes_valid';
    END IF;
    PERFORM public.document_archive_backfill_proved_artifacts_v1();
  END IF;

  -- Pour une facture professionnelle prouvée, l'XML extrait du PDF/A-3 et l'XML original séparé
  -- doivent être le même flux d'octets. Pour une B2C, aucun artefact XML n'est toléré. Cette
  -- jointure attestation/projection rend le contrôle indépendant du JSON fourni par le worker.
  IF EXISTS (
    SELECT 1
      FROM public.document_archive_jobs AS job
      LEFT JOIN public.document_archive_job_artifacts AS pdf_artifact
        ON pdf_artifact."jobId" = job.id
       AND pdf_artifact."companyId" = job."companyId"
       AND pdf_artifact.kind = 'invoice_pdf'
      LEFT JOIN public.document_invoice_pdf_attestations AS attestation
        ON attestation."companyId" = job."companyId"
       AND attestation."documentId" = pdf_artifact."documentId"
       AND attestation."versionId" = pdf_artifact."versionId"
       AND btrim(attestation."documentSha256"::text) = btrim(pdf_artifact.sha256::text)
      LEFT JOIN public.document_archive_job_artifacts AS xml_artifact
        ON xml_artifact."jobId" = job.id
       AND xml_artifact."companyId" = job."companyId"
       AND xml_artifact.kind = 'facturx_xml'
     WHERE job."integrityProof" IS NOT NULL
       AND job.reason IN ('invoice-issued', 'invoice-issued-pdf-only-b2c')
       AND (
         pdf_artifact."documentId" IS NULL
         OR attestation."documentId" IS NULL
         OR (
           job.reason = 'invoice-issued-pdf-only-b2c'
           AND (
             pdf_artifact."contentProfile" <> 'plain_pdf'
             OR attestation.profile <> 'plain_pdf'
             OR attestation."embeddedXmlSha256" IS NOT NULL
             OR xml_artifact."documentId" IS NOT NULL
           )
         )
         OR (
           job.reason = 'invoice-issued'
           AND (
             pdf_artifact."contentProfile" <> 'facturx_pdfa3'
             OR attestation.profile <> 'facturx_pdfa3'
             OR xml_artifact."documentId" IS NULL
             OR xml_artifact."contentProfile" <> 'facturx_xml'
             OR btrim(attestation."embeddedXmlSha256"::text)
                  IS DISTINCT FROM btrim(xml_artifact.sha256::text)
           )
         )
       )
  ) THEN
    RAISE EXCEPTION
      'document archive activation refused: a proved invoice representation is inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_activation_proved_representation_valid';
  END IF;

  -- Le trigger de spool est désormais ouvert par le singleton V2. Réarmer exactement les jobs
  -- non prouvés placés au sentinel, sans effacer leur statut, leur erreur ni leurs tentatives.
  UPDATE public.document_archive_jobs AS job
     SET "leaseToken" = NULL,
         "nextAttemptAt" = statement_timestamp(),
         "updatedAt" = statement_timestamp()
   WHERE job."integrityProof" IS NULL
     AND job."integrityProofSha256" IS NULL
     AND job."completedAt" IS NULL
     AND job."nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RAISE NOTICE 'rearmed % spooled document archive job(s)', changed_rows;

  IF EXISTS (
    SELECT 1
      FROM public.document_archive_jobs AS job
     WHERE job."integrityProof" IS NULL
       AND (
         job."leaseToken" IS NOT NULL
         OR job."nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999'
       )
  ) THEN
    RAISE EXCEPTION 'document archive V2 left a non-proved job leased or spooled'
      USING ERRCODE = '23514',
            CONSTRAINT = 'document_archive_activation_spool_fully_rearmed';
  END IF;
END;
$$;

-- Fermeture atomique des anciens chemins. Les capacités claim/fail restent nommées V1 car
-- leur contrat de lease est commun aux deux protocoles ; enqueue/complete sont les seuls gestes
-- dont le scope légal a changé.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.document_archive_jobs
  FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.document_archive_job_artifacts
  FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.document_archive_protocol_state
  FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.document_invoice_pdf_attestations
  FROM :"app_role";
REVOKE ALL ON TABLE public.document_archive_audit_evidence FROM :"app_role";
-- N-1 utilisait UPDATE uniquement pour un UPSERT strictement no-op sur une version existante.
-- Après retrait de N-1, V2 ferme aussi ce dernier chemin direct : les versions sont append-only.
REVOKE UPDATE, DELETE, TRUNCATE
  ON TABLE public.document_versions
  FROM :"app_role";

REVOKE EXECUTE
  ON FUNCTION public.document_archive_job_enqueue_v1(TEXT, TEXT, TEXT, TEXT)
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.document_archive_job_complete_v1(TEXT, TEXT, TEXT, JSONB, TEXT)
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.document_archive_backfill_proved_artifacts_v1()
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.document_archive_job_scope_v2_is_valid(TEXT, TEXT, TEXT)
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.document_archive_integrity_proof_for_reason_v2_is_valid(
    TEXT, TEXT, TEXT, JSONB
  )
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.generated_legal_archive_representation_v2_is_valid(TEXT)
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.document_archive_job_pdf_attestation_v2_is_valid(
    TEXT, TEXT, TEXT, JSONB
  )
  FROM :"app_role";
REVOKE EXECUTE
  ON FUNCTION public.attest_historical_generated_invoice_pdf_v1(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
  )
  FROM :"app_role";

GRANT EXECUTE
  ON FUNCTION public.document_archive_job_enqueue_v2(TEXT, TEXT, TEXT, TEXT)
  TO :"app_role";
GRANT EXECUTE
  ON FUNCTION public.document_archive_job_claim_v1(
    TEXT, TEXT, TIMESTAMP WITHOUT TIME ZONE, BIGINT, TEXT
  )
  TO :"app_role";
GRANT EXECUTE
  ON FUNCTION public.document_archive_job_fail_v1(TEXT, TEXT, TEXT, BIGINT, TEXT)
  TO :"app_role";
GRANT EXECUTE
  ON FUNCTION public.document_archive_job_complete_v2(TEXT, TEXT, TEXT, JSONB, TEXT)
  TO :"app_role";
GRANT SELECT
  ON TABLE public.document_invoice_pdf_attestations
  TO :"app_role";
GRANT EXECUTE
  ON FUNCTION public.attest_generated_invoice_pdf_v1(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
  )
  TO :"app_role";
GRANT EXECUTE
  ON FUNCTION public.generated_invoice_pdf_attestation_visible_v2(TEXT, TEXT)
  TO :"app_role";

DO $$
DECLARE
  state public.document_archive_protocol_state%ROWTYPE;
  runtime_role_name TEXT := current_setting('bob.document_archive_activation_app_role');
BEGIN
  SELECT *
    INTO STRICT state
    FROM public.document_archive_protocol_state
   WHERE id = 1;

  IF state."activeVersion" <> 2
     OR state."activatedAt" IS NULL
     OR state."activatedByReleaseSha" !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'document archive protocol activation proof is incomplete';
  END IF;

  IF has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'INSERT')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'UPDATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'DELETE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'TRUNCATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'REFERENCES')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_jobs', 'TRIGGER')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'INSERT')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'UPDATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'DELETE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'TRUNCATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'REFERENCES')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_job_artifacts', 'TRIGGER')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'INSERT')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'UPDATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'DELETE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'TRUNCATE')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'REFERENCES')
     OR has_table_privilege(runtime_role_name, 'public.document_archive_protocol_state', 'TRIGGER')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'INSERT')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'UPDATE')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'DELETE')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'TRUNCATE')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'REFERENCES')
     OR has_table_privilege(runtime_role_name, 'public.document_invoice_pdf_attestations', 'TRIGGER')
     OR has_table_privilege(runtime_role_name, 'public.document_versions', 'UPDATE')
     OR has_table_privilege(runtime_role_name, 'public.document_versions', 'DELETE')
     OR has_table_privilege(runtime_role_name, 'public.document_versions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'document archive V2 direct mutation privileges remain';
  END IF;

  IF NOT has_table_privilege(
    runtime_role_name, 'public.document_invoice_pdf_attestations', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'document archive V2 attestation read privilege is missing';
  END IF;

  IF has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_enqueue_v1(text,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_complete_v1(text,text,text,jsonb,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.document_archive_backfill_proved_artifacts_v1()',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_scope_v2_is_valid(text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.document_archive_integrity_proof_for_reason_v2_is_valid(text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.generated_legal_archive_representation_v2_is_valid(text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_pdf_attestation_v2_is_valid(text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       runtime_role_name,
       'public.attest_historical_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'document archive V1 or privileged helper remains executable';
  END IF;

  IF NOT has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_enqueue_v2(text,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_claim_v1(text,text,timestamp without time zone,bigint,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_fail_v1(text,text,text,bigint,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       runtime_role_name,
       'public.document_archive_job_complete_v2(text,text,text,jsonb,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       runtime_role_name,
       'public.attest_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       runtime_role_name,
       'public.generated_invoice_pdf_attestation_visible_v2(text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'document archive V2 runtime capabilities are incomplete';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.document_archive_jobs'::regclass
          AND tgname = 'document_archive_jobs_customer_scope_valid'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.documents'::regclass
          AND tgname = 'documents_generated_invoice_facturx_scope_valid'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.document_archive_jobs'::regclass
          AND tgname = 'document_archive_jobs_cutover_spool_v2'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.documents'::regclass
          AND tgname = 'documents_generated_legal_archive_cutover_v2'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.document_invoice_pdf_attestations'::regclass
          AND tgname = 'document_invoice_pdf_attestations_immutable'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.documents'::regclass
          AND tgname = 'documents_generated_legal_archive_representation_v2'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.document_versions'::regclass
          AND tgname = 'document_versions_generated_legal_archive_representation_v2'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.invoices'::regclass
          AND tgname = 'invoices_capture_archive_audience'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.customers'::regclass
          AND tgname = 'customers_type_legal_piece_immutable'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.document_archive_protocol_state'::regclass
          AND tgname = 'document_archive_protocol_monotonicity'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'document archive V2 database fences are incomplete';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM public.invoices AS invoice
        WHERE invoice.number IS NOT NULL
          AND invoice."issuedAt" IS NOT NULL
          AND invoice.status <> 'draft'::public."InvoiceStatus"
          AND (
            invoice."archiveAudienceAtIssuance" IS NULL
            OR invoice."archiveAudienceAtIssuance" NOT IN ('consumer', 'professional')
          )
     )
     OR EXISTS (
       SELECT 1
         FROM public.documents AS document
        WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
          AND document.kind IN (
            'invoice_pdf'::public."StoredDocumentKind",
            'facturx_xml'::public."StoredDocumentKind",
            'signed_quote'::public."StoredDocumentKind"
          )
          AND NOT coalesce(
            public.generated_legal_archive_representation_v2_is_valid(document.id),
            FALSE
          )
     )
     OR EXISTS (
       SELECT 1
         FROM public.document_archive_jobs AS job
        WHERE job."integrityProof" IS NULL
          AND (
            job."leaseToken" IS NOT NULL
            OR job."nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999'
          )
     ) THEN
    RAISE EXCEPTION 'document archive V2 final data assertions failed';
  END IF;
END;
$$;
SQL

echo "Document archive protocol V2 is active and certified"
