#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

. apps/api/scripts/lib/preserve-cleanup-status.sh

: "${DATABASE_URL:?DATABASE_URL runtime app-role is required}"
: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${APP_DATABASE_ROLE:?APP_DATABASE_ROLE runtime role name is required}"
: "${RUN_RLS_CERT:?RUN_RLS_CERT=true is required}"
: "${RLS_CERT_CLEANUP:?RLS_CERT_CLEANUP=true is required}"

# Certifications contre la base DISTANTE : le defaut Prisma de 5 s par transaction
# interactive produit des P2028 de latence WAN sans aucun drift. Rituel uniquement —
# la variable n'existe pas dans l'environnement runtime Railway.
PRISMA_TRANSACTION_TIMEOUT_MS="${PRISMA_TRANSACTION_TIMEOUT_MS:-30000}"
export PRISMA_TRANSACTION_TIMEOUT_MS

if [ "$RUN_RLS_CERT" != "true" ] || [ "$RLS_CERT_CLEANUP" != "true" ]; then
  echo "RUN_RLS_CERT=true and RLS_CERT_CLEANUP=true are mandatory" >&2
  exit 1
fi

cleanup_rls_cert() {
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cleanup.sql
}

cleanup_release_on_exit() {
  original_status=$?
  trap - EXIT HUP INT TERM
  preserve_exit_status_after_cleanup "$original_status" cleanup_rls_cert
}

certify_agent_mission_release_acl() {
  connected_role="$(
    psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT current_user'
  )"
  if [ "$connected_role" != "$APP_DATABASE_ROLE" ]; then
    echo "DATABASE_URL must connect as APP_DATABASE_ROLE for AgentMission ACL certification" >&2
    return 1
  fi
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v app_role="$APP_DATABASE_ROLE" \
    -f apps/api/prisma/agent-missions-release-cert.sql
}

certify_invoice_settlement_protocol() {
  local_version="$(
    psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -c 'SELECT "activeVersion" FROM public.invoice_settlement_protocol_state WHERE id = 1'
  )"
  case "$local_version" in
    1)
      RUN_POSTGRES_INVOICE_SETTLEMENT_ROLLOUT_CERT=true \
        pnpm --filter @bob/api exec vitest run --testTimeout=30000 \
          src/persistence/prisma/invoice-settlement-rollout.postgres.test.ts
      ;;
    2)
      RUN_POSTGRES_INVOICE_SETTLEMENT_CERT=true \
        pnpm --filter @bob/api exec vitest run --testTimeout=30000 \
          src/persistence/prisma/invoice-settlement-semantics.postgres.test.ts
      ;;
    *)
      echo "invoice settlement protocol singleton is missing or invalid" >&2
      return 1
      ;;
  esac
}

certify_document_archive_protocol() {
  local_version="$(
    psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -c 'SELECT "activeVersion" FROM public.document_archive_protocol_state WHERE id = 1'
  )"
  case "$local_version" in
    1)
      RUN_POSTGRES_DOCUMENT_ARCHIVE_ROLLOUT_CERT=true \
        pnpm --filter @bob/api exec vitest run --testTimeout=30000 \
          src/persistence/prisma/document-archive-rollout.postgres.test.ts
      ;;
    2)
      RUN_POSTGRES_DOCUMENT_ARCHIVE_CERT=true \
        pnpm --filter @bob/api exec vitest run --testTimeout=30000 \
          src/persistence/prisma/document-archive-integrity.postgres.test.ts
      ;;
    *)
      echo "document archive protocol singleton is missing or invalid" >&2
      return 1
      ;;
  esac
}

certify_generated_legal_storage_fence() {
  fence_count="$(
    psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
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
   AND (function_owner.rolsuper OR function_owner.rolbypassrls);
SQL
  )"
  if [ "$fence_count" != "1" ]; then
    echo "generated legal Storage immutability trigger is missing or invalid" >&2
    return 1
  fi
}

certify_openai_native_legacy_gate_pregrant() {
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 \
    -v app_role="$APP_DATABASE_ROLE" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT pg_catalog.set_config('bob.openai_native_legacy_gate_app_role', :'app_role', true);
DO $$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.openai_native_legacy_gate_app_role', true),
    ''
  );
  forbidden_privilege TEXT;
BEGIN
  IF app_role_name IS NULL OR pg_catalog.to_regrole(app_role_name) IS NULL THEN
    RAISE EXCEPTION 'OpenAI native legacy gate requires an existing runtime role';
  END IF;
  IF pg_catalog.to_regclass(
       'public.realtime_native_legacy_subject_admission'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.guard_realtime_native_legacy_subject_admission_v1()'
     ) IS NULL THEN
    RAISE EXCEPTION 'OpenAI native legacy gate migration is incomplete';
  END IF;

  FOREACH forbidden_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
         app_role_name,
         'public.realtime_native_legacy_subject_admission',
         forbidden_privilege
       ) THEN
      RAISE EXCEPTION
        'OpenAI native legacy gate leaked % before runtime grants',
        forbidden_privilege;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege(
       app_role_name,
       'public.guard_realtime_native_legacy_subject_admission_v1()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       app_role_name,
       'public.guard_realtime_native_delivery_v1()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'OpenAI native legacy gate helper leaked before runtime grants';
  END IF;
END;
$$;
ROLLBACK;
SQL
}

certify_openai_native_release_metadata() {
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" \
    -f apps/api/prisma/openai-native-release-cert.sql
}

certify_realtime_global_capacity_release_metadata() {
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" \
    -f apps/api/prisma/realtime-global-capacity-release-cert.sql
}

certify_document_archive_evidence_privacy() {
  psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  direct_authority RECORD;
  evidence_relation RECORD;
  private_relation RECORD;
  private_table TEXT;
  control_relation RECORD;
  control_table TEXT;
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
BEGIN
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
    SELECT 1
      FROM pg_catalog.pg_policy
     WHERE polrelid = evidence_relation.oid
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

  FOREACH control_table IN ARRAY ARRAY[
    'document_archive_protocol_state',
    'invoice_settlement_protocol_state'
  ]::TEXT[] LOOP
    SELECT relation.oid, relation.relacl, relation.relowner
      INTO STRICT control_relation
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = control_table
       AND relation.relkind = 'r';

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.aclexplode(
          coalesce(
            control_relation.relacl,
            pg_catalog.acldefault('r', control_relation.relowner)
          )
        ) AS privilege
       WHERE privilege.grantee = 0
         AND privilege.privilege_type IN (
           'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
         )
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains a mutation privilege on %', control_table;
    END IF;

    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
         AND pg_catalog.has_table_privilege(
           exposed_role,
           pg_catalog.format('public.%I', control_table),
           'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
         ) THEN
        RAISE EXCEPTION '% retains a mutation privilege on %', exposed_role, control_table;
      END IF;
    END LOOP;
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
SQL
}

grant_app_role() {
  if [ -z "${APP_DATABASE_ROLE:-}" ]; then
    echo "APP_DATABASE_ROLE unset; skipping explicit runtime grants"
    return 0
  fi

  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="$APP_DATABASE_ROLE" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"app_role";
-- Le rejeu d'une release rencontre des objets déjà transférés à leurs autorités NOLOGIN.
-- Un GRANT ... ON ALL TABLES exécuté comme déployeur échoue alors sur Supabase et, pire,
-- masquerait le propriétaire exact en CI superuser. Le socle large ne cible donc que les
-- relations encore possédées par le déployeur. Chaque autorité globale reconstruit ensuite
-- ses ACL minimales sous SET ROLE dans son provisioner dédié.
SELECT pg_catalog.format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
  namespace.nspname,
  relation.relname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
 WHERE namespace.nspname = 'public'
   AND relation.relkind IN ('r', 'p', 'v', 'f')
   -- Cette autorité globale reste fermée jusqu'à son provisioner owner-aware. Même au premier
   -- déploiement, elle ne traverse jamais une fenêtre DML ouverte au runtime.
   AND relation.relname <> 'realtime_global_capacity'
   AND relation.relowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec
SELECT pg_catalog.format(
  'GRANT SELECT ON TABLE %I.%I TO %I',
  namespace.nspname,
  relation.relname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
 WHERE namespace.nspname = 'public'
   AND relation.relkind = 'm'
   AND relation.relowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec
-- Une ancienne release a pu accorder du DML à cette autorité avant son transfert d'ownership.
-- L'exclusion du grant ci-dessus empêche toute nouvelle ouverture ; cette normalisation retire
-- aussi le reliquat historique immédiatement, sous l'owner exact, dans la même transaction.
DO $capacity_runtime_acl_owner$
DECLARE
  capacity_owner OID;
BEGIN
  SELECT relation.relowner
    INTO STRICT capacity_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.realtime_global_capacity'::regclass;

  IF capacity_owner <> (
       SELECT role.oid
         FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user
     )
     AND NOT pg_catalog.pg_has_role(current_user, capacity_owner, 'SET') THEN
    RAISE EXCEPTION
      'realtime_global_capacity has an owner unavailable through SET membership';
  END IF;
END;
$capacity_runtime_acl_owner$;
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.realtime_global_capacity FROM %I; RESET ROLE;',
  owner.rolname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_global_capacity'::regclass
\gexec
-- TRUNCATE n'est jamais une capacité runtime. La liste explicite répare aussi un ancien ACL,
-- y compris sur le lease dont le DELETE ciblé reste nécessaire à l'autorité de terminaison.
REVOKE TRUNCATE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
FROM :"app_role";
-- Ces registres sont append-only pour le role runtime. Les policies RLS seules ne
-- suffisent pas : un futur changement de policy ne doit pas reactiver leur mutation.
REVOKE UPDATE, DELETE ON TABLE
  public.document_analyses,
  public.expense_creation_requests,
  public.quote_creation_requests,
  public.bank_balance_snapshots
FROM :"app_role";
-- Rail global monotone du protocole de règlement : le runtime le lit via le trigger, mais seule
-- DIRECT_URL peut activer V2 après retrait prouvé de N-1. Les snapshots d'antécédents n'ont
-- aucune capacité UPDATE, même si une future policy RLS dérive.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.invoice_settlement_protocol_state
FROM :"app_role";
REVOKE UPDATE, TRUNCATE ON TABLE public.invoice_predecessors FROM :"app_role";
-- Les originaux du coffre ne sont jamais supprimés par le runtime. Les versions sont strictement
-- append-only ; les seules mutations admises sur `documents` sont les métadonnées bornées et
-- contrôlées par le trigger `documents_original_facts_immutable`.
REVOKE DELETE, TRUNCATE ON TABLE public.documents FROM :"app_role";
REVOKE DELETE, TRUNCATE ON TABLE public.document_versions FROM :"app_role";
-- Aucun use case ne supprime une ligne de devis canonique. Les brouillons éditables sont portés
-- par quote_draft_slots ; révoquer DELETE ici protège définitivement le contrat signé et son
-- archive polymorphe contre une dérive de policy ou une requête SQL directe.
REVOKE DELETE ON TABLE public.quotes FROM :"app_role";
-- Rail global monotone de l'archive : lecture runtime seulement, activation via DIRECT_URL.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.document_archive_protocol_state
FROM :"app_role";
-- Preuve globale de cutover, sans PII mais strictement réservée aux opérations DIRECT_URL.
REVOKE ALL ON TABLE public.document_archive_audit_evidence FROM :"app_role";
-- La projection relationnelle est toujours privée. L'outbox conserve temporairement INSERT /
-- UPDATE en phase expand uniquement pour que N-1 puisse déposer un ordre qui sera spoolé ; aucune
-- archive légale générée ne peut être matérialisée avant l'activation post-readiness.
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.document_archive_jobs,
  public.document_archive_job_artifacts
FROM :"app_role";
REVOKE INSERT, UPDATE ON TABLE public.document_archive_job_artifacts FROM :"app_role";
-- Le détecteur d'octets écrit l'attestation par une capacité bornée. Le runtime peut la relire via
-- RLS mais n'a aucun geste SQL direct ; le helper profond non tenant-scopé reste privé.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.document_invoice_pdf_attestations
FROM :"app_role";
GRANT SELECT ON TABLE public.document_invoice_pdf_attestations TO :"app_role";
REVOKE EXECUTE ON FUNCTION public.generated_legal_archive_representation_v2_is_valid(TEXT)
  FROM :"app_role";
REVOKE EXECUTE ON FUNCTION public.document_archive_job_pdf_attestation_v2_is_valid(
  TEXT, TEXT, TEXT, JSONB
) FROM :"app_role";
GRANT EXECUTE ON FUNCTION public.attest_generated_invoice_pdf_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.generated_invoice_pdf_attestation_visible_v2(TEXT, TEXT)
  TO :"app_role";
GRANT EXECUTE ON FUNCTION public.document_archive_job_enqueue_v2(TEXT, TEXT, TEXT, TEXT)
  TO :"app_role";
GRANT EXECUTE ON FUNCTION public.document_archive_job_claim_v1(
  TEXT, TEXT, TIMESTAMP WITHOUT TIME ZONE, BIGINT, TEXT
) TO :"app_role";
GRANT EXECUTE ON FUNCTION public.document_archive_job_fail_v1(TEXT, TEXT, TEXT, BIGINT, TEXT)
  TO :"app_role";
GRANT EXECUTE ON FUNCTION public.document_archive_job_complete_v2(TEXT, TEXT, TEXT, JSONB, TEXT)
  TO :"app_role";
SELECT ("activeVersion" = 1)::text AS document_archive_expand
  FROM public.document_archive_protocol_state
 WHERE id = 1
\gset
\if :document_archive_expand
  GRANT EXECUTE ON FUNCTION public.attest_historical_generated_invoice_pdf_v1(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
  ) TO :"app_role";
  GRANT INSERT, UPDATE ON TABLE public.document_archive_jobs TO :"app_role";
  -- Le CHECK de forme est SECURITY INVOKER : N-1 doit pouvoir l'évaluer tant que ses écritures
  -- directes sont tolérées. Cette capacité pure est retirée dans la même transaction que V2.
  GRANT EXECUTE ON FUNCTION public.document_archive_integrity_proof_for_reason_v2_is_valid(
    TEXT, TEXT, TEXT, JSONB
  ) TO :"app_role";
  -- N-1 confirme encore un retry de version via UPSERT ... DO UPDATE. Le trigger n'autorise
  -- qu'un no-op exact et la policy est elle-même bornée au protocole V1.
  GRANT UPDATE ON TABLE public.document_versions TO :"app_role";
  GRANT EXECUTE ON FUNCTION public.document_archive_job_enqueue_v1(TEXT, TEXT, TEXT, TEXT)
    TO :"app_role";
  GRANT EXECUTE ON FUNCTION public.document_archive_job_complete_v1(
    TEXT, TEXT, TEXT, JSONB, TEXT
  ) TO :"app_role";
\else
  REVOKE EXECUTE ON FUNCTION public.attest_historical_generated_invoice_pdf_v1(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
  ) FROM :"app_role";
  REVOKE INSERT, UPDATE ON TABLE public.document_archive_jobs FROM :"app_role";
  REVOKE EXECUTE ON FUNCTION public.document_archive_integrity_proof_for_reason_v2_is_valid(
    TEXT, TEXT, TEXT, JSONB
  ) FROM :"app_role";
  REVOKE UPDATE ON TABLE public.document_versions FROM :"app_role";
  REVOKE EXECUTE ON FUNCTION public.document_archive_job_enqueue_v1(TEXT, TEXT, TEXT, TEXT)
    FROM :"app_role";
  REVOKE EXECUTE ON FUNCTION public.document_archive_job_complete_v1(
    TEXT, TEXT, TEXT, JSONB, TEXT
  ) FROM :"app_role";
\endif
-- Une société se clôture, elle ne se supprime jamais depuis le runtime : son identité légale
-- reste nécessaire aux pièces conservées et un DELETE suivi d'un INSERT la ressusciterait.
REVOKE DELETE ON TABLE public.companies FROM :"app_role";
REVOKE DELETE, TRUNCATE ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_speech_artifacts,
  public.stripe_subscription_invoices
FROM :"app_role";
-- DELETE reste borné par deux policies (tenant + fence RESTRICTIVE) et un trigger de rétention.
-- Aucune DDL relationnelle ni suppression des contrôles dépendants ne fuit au runtime.
GRANT DELETE ON TABLE public.realtime_native_speech_deliveries TO :"app_role";
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.realtime_native_speech_deliveries
FROM :"app_role";
REVOKE ALL ON TABLE public.realtime_native_speech_maintenance_cursors FROM :"app_role";
-- Le gate rolling N-1 est une autorité globale de déploiement. Le trigger natif peut le lire
-- avec ses droits propriétaire, mais le runtime tenanté ne doit ni l'observer ni le muter.
REVOKE ALL ON TABLE public.realtime_native_legacy_subject_admission FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_control_grants,
  public.realtime_control_consumptions,
  public.realtime_voice_usage_events
FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE ON TABLE public.realtime_voice_usage_daily FROM :"app_role";
-- Les triggers invoquent ces fonctions sans privilège EXECUTE du caller. Les exposer permettrait
-- sinon de contourner l'adapter CAS et ses preuves applicatives.
REVOKE ALL ON FUNCTION public.assert_realtime_native_delivery_fence_v1(
  TEXT, CHAR(64), UUID, TEXT, INTEGER, CHAR(64), CHAR(64), INTEGER
) FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_v1() FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_native_legacy_subject_admission_v1()
  FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_native_speech_slo_v1() FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_delete_v1() FROM :"app_role";
REVOKE ALL ON FUNCTION public.deny_realtime_native_delivery_truncate_v1() FROM :"app_role";
-- Ces helpers sont une autorité de trigger, pas une API. Une ancienne default ACL ou un GRANT
-- manuel vers un rôle tiers est normalisé ici ; leur ACL exacte reste owner-only.
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
  function.oid::regprocedure,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee_role.rolname) END
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
 WHERE function.oid IN (
   'public.assert_realtime_native_delivery_fence_v1(text,character,uuid,text,integer,character,character,integer)'::regprocedure,
   'public.guard_realtime_native_delivery_v1()'::regprocedure,
   'public.guard_realtime_native_legacy_subject_admission_v1()'::regprocedure,
   'public.guard_realtime_native_speech_slo_v1()'::regprocedure,
   'public.guard_realtime_native_delivery_delete_v1()'::regprocedure,
   'public.deny_realtime_native_delivery_truncate_v1()'::regprocedure
 )
   AND privilege.grantee <> function.proowner
\gexec
REVOKE ALL ON FUNCTION public.assert_realtime_control_grant_binding_v3(
  TEXT, INTEGER, UUID, UUID, TEXT, UUID, UUID, INTEGER, CHAR(64),
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM :"app_role";
REVOKE ALL ON FUNCTION public.assert_realtime_control_consumption_binding_v3(
  TEXT, UUID, UUID, UUID, UUID, TIMESTAMPTZ
) FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_control_grant() FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_control_grant_v2() FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_control_consumption() FROM :"app_role";
REVOKE ALL ON FUNCTION public.guard_realtime_control_consumption_v2() FROM :"app_role";
-- Les registres globaux de versions sont monotones, append-only et isolés par keySpace. Le runtime
-- peut seulement les lire ; seul DIRECT_URL prépare ou retire une version au déploiement.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.realtime_mistral_conversation_key_version_floors,
  public.realtime_mistral_conversation_key_bindings,
  public.realtime_mistral_conversation_identity_key_version_floors,
  public.realtime_mistral_conversation_identity_key_bindings,
  public.realtime_mistral_conversation_terminal_receipts
FROM :"app_role";
REVOKE ALL ON FUNCTION public.retained_bob_live_subject_hmac_key_bindings()
  FROM :"app_role";
GRANT EXECUTE ON FUNCTION public.retained_bob_live_subject_hmac_key_bindings()
  TO :"app_role";
REVOKE ALL ON FUNCTION public.retained_openai_native_proof_hmac_key_bindings()
  FROM :"app_role";
GRANT EXECUTE ON FUNCTION public.retained_openai_native_proof_hmac_key_bindings()
  TO :"app_role";
-- Supabase accorde d'office EXECUTE aux roles API PostgREST (anon/authenticated/
-- service_role) sur toute fonction publique (defaults FOR ROLE postgres) : exposition
-- RPC indue de fonctions internes. Revocation GENERALE + suppression du default,
-- conditionnelles (roles absents en CI) — privileges, jamais adhesions.
SELECT DISTINCT format(
  'SET ROLE %I; REVOKE ALL ON FUNCTION %s FROM %I; RESET ROLE;',
  owner.rolname, function.oid::regprocedure, api_role.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function.pronamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
  ) AS privilege
  JOIN pg_catalog.pg_roles AS api_role ON api_role.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND api_role.rolname IN ('anon', 'authenticated', 'service_role')
   AND (owner.rolname = current_user
        OR pg_catalog.pg_has_role(current_user, owner.oid, 'SET'))
\gexec
-- Meme pre-octroi Supabase sur les TABLES et SEQUENCES publiques : revocation des
-- objets possedes par le deployeur et porteurs d'un grant API, puis des defaults.
SELECT DISTINCT format(
  'SET ROLE %I; REVOKE ALL ON TABLE %I.%I FROM %I; RESET ROLE;',
  owner.rolname, namespace.nspname, relation.relname, api_role.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
  ) AS privilege
  JOIN pg_catalog.pg_roles AS api_role ON api_role.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND relation.relkind IN ('r', 'p', 'v', 'm')
   AND api_role.rolname IN ('anon', 'authenticated', 'service_role')
   AND (owner.rolname = current_user
        OR pg_catalog.pg_has_role(current_user, owner.oid, 'SET'))
\gexec
SELECT DISTINCT format(
  'SET ROLE %I; REVOKE ALL ON SEQUENCE %I.%I FROM %I; RESET ROLE;',
  owner.rolname, namespace.nspname, relation.relname, api_role.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(relation.relacl, pg_catalog.acldefault('s', relation.relowner))
  ) AS privilege
  JOIN pg_catalog.pg_roles AS api_role ON api_role.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND relation.relkind = 'S'
   AND api_role.rolname IN ('anon', 'authenticated', 'service_role')
   AND (owner.rolname = current_user
        OR pg_catalog.pg_has_role(current_user, owner.oid, 'SET'))
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE %s FROM %I',
  current_user, object_kind.clause, api_role.rolname
)
  FROM pg_catalog.pg_roles AS api_role
  CROSS JOIN (VALUES
    ('EXECUTE ON FUNCTIONS'),
    ('ALL ON TABLES'),
    ('ALL ON SEQUENCES')
  ) AS object_kind(clause)
 WHERE api_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec
-- Le runtime invoque uniquement les deux capacités SECURITY DEFINER bornées. Il ne peut jamais
-- endosser le rôle propriétaire NOLOGIN ni atteindre ses ACL de table sous-jacentes.
REVOKE bob_mistral_bootstrap_reaper FROM :"app_role" CASCADE;
SELECT pg_catalog.format(
  'GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I.%I TO %I',
  namespace.nspname,
  relation.relname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
 WHERE namespace.nspname = 'public'
   AND relation.relkind = 'S'
   AND relation.relowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
\i apps/api/prisma/agent-missions-runtime-grants.sql
SQL
}

ensure_mistral_bootstrap_reaper_role() {
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
-- Supabase intercepte fatalement tout GRANT/REVOKE d'adhesion visant postgres
-- (connexion tuee) : l'adhesion SET est donc accordee IMPLICITEMENT a la creation
-- (createrole_self_grant, PG16+), sans aucun fallback GRANT explicite.
SET createrole_self_grant = 'set';

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_mistral_bootstrap_reaper'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'bob_mistral_bootstrap_reaper'
) \gexec

DO $$
DECLARE
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
  owner_oid OID;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_mistral_bootstrap_reaper';

  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = owner_oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper is not available through implicit SET membership; create it as this deployer with createrole_self_grant=set before retrying';
  END IF;
END;
$$;

-- Un role DIRECT_URL CREATEROLE non-superuser peut verrouiller ces attributs, mais PostgreSQL
-- lui interdit de reaffirmer NOSUPERUSER/NOBYPASSRLS/NOREPLICATION, meme a false. On atteste donc
-- ces trois attributs ci-dessous au lieu de rendre le rejeu dependant d'un superuser.
ALTER ROLE bob_mistral_bootstrap_reaper
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;

DO $$
DECLARE
  reaper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT reaper
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_mistral_bootstrap_reaper';

  IF reaper.rolcanlogin
     OR reaper.rolsuper
     OR reaper.rolcreatedb
     OR reaper.rolcreaterole
     OR reaper.rolinherit
     OR reaper.rolreplication
     OR reaper.rolbypassrls THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper must remain NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS';
  END IF;
END;
$$;

-- Le rôle propriétaire n'hérite d'aucun autre rôle. Réciproquement, aucun rôle de connexion ne
-- peut l'endosser : seul le rôle DIRECT_URL courant reste membre le temps de transférer/attester
-- l'ownership des deux fonctions bornées.
SELECT format('REVOKE %I FROM %I CASCADE', parent_role.rolname, 'bob_mistral_bootstrap_reaper')
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent_role ON parent_role.oid = membership.roleid
 WHERE membership.member = 'bob_mistral_bootstrap_reaper'::regrole
   AND parent_role.rolname <> 'postgres'
\gexec

SELECT format('REVOKE %I FROM %I CASCADE', 'bob_mistral_bootstrap_reaper', member_role.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE membership.roleid = 'bob_mistral_bootstrap_reaper'::regrole
   AND member_role.rolname NOT IN (current_user, 'postgres')
\gexec

DO $$
DECLARE
  owner_oid OID;
BEGIN
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_mistral_bootstrap_reaper';

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = owner_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE membership.roleid = owner_oid
       AND member_role.rolname <> current_user
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper has an unexpected member; membership remediation must be performed outside this release without targeting postgres';
  END IF;
END;
$$;
SQL
}

provision_mistral_bootstrap_reaper() {
  ensure_mistral_bootstrap_reaper_role
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
SELECT pg_catalog.set_config('bob.mistral_reaper_app_role', :'app_role', true);

-- Première installation : DIRECT_URL possède encore les fonctions créées par la migration.
-- Rejeu : elles appartiennent déjà au NOLOGIN. Tout autre owner est refusé avant mutation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
       'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
     )
       AND function.proowner NOT IN (
         (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user),
         'bob_mistral_bootstrap_reaper'::regrole
       )
  ) THEN
    RAISE EXCEPTION 'Mistral retention function has an unexpected owner';
  END IF;
END;
$$;

-- PostgreSQL exige que le nouvel owner ait CREATE sur le schema lors d'un transfert. Cette
-- capacite n'existe que dans cette transaction d'administration et est retiree avant COMMIT.
GRANT CREATE ON SCHEMA public TO bob_mistral_bootstrap_reaper;

SELECT format(
  'ALTER FUNCTION %s OWNER TO bob_mistral_bootstrap_reaper',
  function.oid::regprocedure
)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
   'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec

-- L'idempotence est explicite : au premier passage comme aux suivants, la configuration et les
-- ACL fonctionnelles sont appliquées en endossant leur owner exact, puis le rôle est relâché.
SET LOCAL ROLE bob_mistral_bootstrap_reaper;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  FROM PUBLIC;
-- Un ancien rôle, même transitivement hérité par le runtime, ne doit conserver aucun EXECUTE.
-- Le propriétaire normalise toutes les ACL avant de recréer l'unique grant runtime attendu.
SELECT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
  function.oid::regprocedure,
  grantee.rolname
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
   'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
 )
   AND privilege.grantee <> function.proowner
   AND (:'app_role' = '' OR grantee.rolname <> :'app_role')
 GROUP BY function.oid, grantee.rolname
 ORDER BY bool_or(privilege.is_grantable) DESC, function.oid, grantee.rolname
\gexec
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER)
  SET row_security = on;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SET search_path = pg_catalog;
ALTER FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER)
  SET row_security = on;
SELECT format(
  'REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) FROM %I CASCADE',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE ALL ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER) FROM %I CASCADE',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) TO %I',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(INTEGER) TO %I',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM bob_mistral_bootstrap_reaper;
GRANT USAGE ON SCHEMA public TO bob_mistral_bootstrap_reaper;
REVOKE ALL ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
  FROM bob_mistral_bootstrap_reaper;
-- REVOKE table ne retire pas les ACL de colonnes PostgreSQL. Le rejeu retire donc tout ancien
-- droit de colonne du reaper avant de reconstruire exactement son contrat minimal ci-dessous.
SELECT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM bob_mistral_bootstrap_reaper CASCADE',
  attribute.attname,
  namespace.nspname,
  target.relname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.grantee = 'bob_mistral_bootstrap_reaper'::regrole
 GROUP BY namespace.nspname, target.relname, attribute.attname
\gexec
-- Une délégation tierce vers PUBLIC ne peut pas être retirée par le seul owner. On casse donc
-- d'abord chaque grant option non propriétaire, en cascade, tout en conservant son droit de base.
SELECT format(
  'REVOKE GRANT OPTION FOR %s ON TABLE %I.%I FROM %I CASCADE',
  privilege.privilege_type,
  namespace.nspname,
  target.relname,
  grantee.rolname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
 CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.is_grantable
   AND privilege.grantee <> target.relowner
 ORDER BY namespace.nspname, target.relname, grantee.rolname, privilege.privilege_type
\gexec
SELECT format(
  'REVOKE GRANT OPTION FOR %s (%I) ON TABLE %I.%I FROM %I CASCADE',
  privilege.privilege_type,
  attribute.attname,
  namespace.nspname,
  target.relname,
  grantee.rolname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.is_grantable
   AND privilege.grantee <> target.relowner
 ORDER BY namespace.nspname, target.relname, attribute.attname, grantee.rolname,
          privilege.privilege_type
\gexec
-- Les droits effectifs du reaper ne doivent jamais provenir de PUBLIC. Les ACL de colonnes
-- PUBLIC sont elles aussi nettoyees explicitement et en cascade.
REVOKE ALL PRIVILEGES ON TABLE
  public.realtime_mistral_conversation_bootstrap_tickets,
  public.realtime_mistral_conversation_missions,
  public.realtime_mistral_conversation_terminal_receipts,
  public.realtime_mistral_conversation_resume_tickets,
  public.realtime_mistral_conversation_outbox,
  public.realtime_mistral_conversation_commands,
  public.realtime_session_leases
  FROM PUBLIC CASCADE;
SELECT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC CASCADE',
  attribute.attname,
  namespace.nspname,
  target.relname
)
  FROM pg_catalog.pg_class AS target
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
 WHERE namespace.nspname = 'public'
   AND target.relname IN (
     'realtime_mistral_conversation_bootstrap_tickets',
     'realtime_mistral_conversation_missions',
     'realtime_mistral_conversation_terminal_receipts',
     'realtime_mistral_conversation_resume_tickets',
     'realtime_mistral_conversation_outbox',
     'realtime_mistral_conversation_commands',
     'realtime_session_leases'
   )
   AND privilege.grantee = 0
 GROUP BY namespace.nspname, target.relname, attribute.attname
\gexec
GRANT SELECT (id, "companyId", "admissionSessionId", "retentionExpiresAt")
  ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  id, "companyId", "sessionHandle", "initialBootstrapId", phase,
  "subjectHash", "subjectKeyVersion", protocol, "missionConnectionEpoch",
  "retainedFromServerSequence", "nextServerSequence", "terminalReason", "closedAt",
  "replayGraceExpiresAt", "retentionExpiresAt"
) ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_missions
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
  "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
) ON TABLE public.realtime_mistral_conversation_terminal_receipts
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  id, "missionId", "companyId", "sessionHandle", "initialBootstrapId", "retentionExpiresAt"
) ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT UPDATE (id) ON TABLE public.realtime_mistral_conversation_resume_tickets
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT (
  "missionId", "companyId", "sessionHandle", "serverSequence", "retentionExpiresAt"
)
  ON TABLE public.realtime_mistral_conversation_outbox
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_outbox
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT ("missionId", "companyId", "sessionHandle", "retentionExpiresAt")
  ON TABLE public.realtime_mistral_conversation_commands
  TO bob_mistral_bootstrap_reaper;
GRANT DELETE ON TABLE public.realtime_mistral_conversation_commands
  TO bob_mistral_bootstrap_reaper;
GRANT SELECT ("companyId", "sessionId") ON TABLE public.realtime_session_leases
  TO bob_mistral_bootstrap_reaper;

-- Le runtime ne reçoit que l'entrée fonctionnelle ; toute mutation SQL directe et toute
-- capacité SET ROLE restent fermées, y compris lors d'une release rejouée sur un ancien ACL.
SELECT format('REVOKE %I FROM %I', 'bob_mistral_bootstrap_reaper', :'app_role')
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE TRUNCATE ON TABLE %s FROM %I',
  'public.realtime_mistral_conversation_bootstrap_tickets,
   public.realtime_mistral_conversation_missions,
   public.realtime_mistral_conversation_terminal_receipts,
   public.realtime_mistral_conversation_resume_tickets,
   public.realtime_mistral_conversation_outbox,
   public.realtime_mistral_conversation_commands,
   public.realtime_session_leases',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
SELECT format(
  'REVOKE DELETE ON TABLE %s FROM %I',
  'public.realtime_mistral_conversation_bootstrap_tickets,
   public.realtime_mistral_conversation_missions,
   public.realtime_mistral_conversation_resume_tickets,
   public.realtime_mistral_conversation_outbox,
   public.realtime_mistral_conversation_commands,
   public.realtime_mistral_conversation_terminal_receipts',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec
-- Le rôle peut posséder exactement ces deux fonctions et aucun autre objet de cette base. La
-- recherche de dépendances d'ownership attrape tables, schémas, types et objets futurs sans
-- entretenir une liste fragile par catalogue.
DO $$
DECLARE
  database_oid OID;
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.mistral_reaper_app_role', true),
    ''
  );
  app_role_oid OID;
  legacy_oid OID :=
    'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure;
  ordered_oid OID :=
    'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure;
BEGIN
  IF app_role_name IS NOT NULL THEN
    SELECT oid INTO app_role_oid
      FROM pg_catalog.pg_roles
     WHERE rolname = app_role_name;
    IF app_role_oid IS NULL THEN
      RAISE EXCEPTION 'Mistral retention app role does not exist';
    END IF;
  END IF;

  SELECT oid INTO STRICT database_oid
    FROM pg_catalog.pg_database
   WHERE datname = current_database();

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_shdepend AS ownership
     WHERE ownership.refclassid = 'pg_authid'::regclass
       AND ownership.refobjid = 'bob_mistral_bootstrap_reaper'::regrole
       AND ownership.deptype = 'o'
       AND (ownership.dbid = 0 OR ownership.dbid = database_oid)
       AND NOT (
         ownership.dbid = database_oid
         AND ownership.classid = 'pg_proc'::regclass
         AND ownership.objid IN (legacy_oid, ordered_oid)
         AND ownership.objsubid = 0
       )
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper owns an object outside the two retention functions';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         function.proowner <> 'bob_mistral_bootstrap_reaper'::regrole
         OR NOT function.prosecdef
         OR cardinality(COALESCE(function.proconfig, ARRAY[]::text[])) <> 2
         OR NOT COALESCE(function.proconfig, ARRAY[]::text[])
                @> ARRAY['search_path=pg_catalog', 'row_security=on']
       )
  ) THEN
    RAISE EXCEPTION
      'bob_mistral_bootstrap_reaper function ownership or SECURITY DEFINER config is invalid';
  END IF;

  IF pg_catalog.has_schema_privilege(
    'bob_mistral_bootstrap_reaper',
    'public',
    'CREATE'
  ) THEN
    RAISE EXCEPTION 'bob_mistral_bootstrap_reaper retains CREATE on schema public';
  END IF;

  IF app_role_oid IS NOT NULL
     AND (
       pg_catalog.pg_has_role(
         app_role_oid,
         'bob_mistral_bootstrap_reaper'::regrole,
         'MEMBER'
       )
       OR pg_catalog.pg_has_role(
         app_role_oid,
         'bob_mistral_bootstrap_reaper'::regrole,
         'SET'
       )
     ) THEN
    RAISE EXCEPTION 'Mistral retention app role is a member of or can SET ROLE to the reaper';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         privilege.privilege_type <> 'EXECUTE'
         OR privilege.grantee = 0
         OR (
           privilege.grantee <> function.proowner
           AND privilege.grantee IS DISTINCT FROM app_role_oid
         )
         OR (
           privilege.grantee = app_role_oid
           AND (privilege.grantor <> function.proowner OR privilege.is_grantable)
         )
       )
  ) THEN
    RAISE EXCEPTION 'Mistral retention function ACL contains an unexpected grant';
  END IF;

  IF app_role_oid IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (legacy_oid, ordered_oid)
       AND (
         SELECT count(*)
           FROM pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
           ) AS privilege
          WHERE privilege.grantee = app_role_oid
            AND privilege.grantor = function.proowner
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
       ) <> 1
  ) THEN
    RAISE EXCEPTION 'Mistral retention app role EXECUTE grant is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS target
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(target.relacl, pg_catalog.acldefault('r', target.relowner))
     ) AS privilege
     WHERE namespace.nspname = 'public'
       AND target.relname IN (
         'realtime_mistral_conversation_bootstrap_tickets',
         'realtime_mistral_conversation_missions',
         'realtime_mistral_conversation_terminal_receipts',
         'realtime_mistral_conversation_resume_tickets',
         'realtime_mistral_conversation_outbox',
         'realtime_mistral_conversation_commands',
         'realtime_session_leases'
       )
       AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS target
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE namespace.nspname = 'public'
       AND target.relname IN (
         'realtime_mistral_conversation_bootstrap_tickets',
         'realtime_mistral_conversation_missions',
         'realtime_mistral_conversation_terminal_receipts',
         'realtime_mistral_conversation_resume_tickets',
         'realtime_mistral_conversation_outbox',
         'realtime_mistral_conversation_commands',
         'realtime_session_leases'
       )
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'Mistral retention scoped table or column ACL exposes PUBLIC';
  END IF;
END;
$$;
SQL
}

ensure_openai_native_maintenance_directory_role() {
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
-- Supabase intercepte fatalement tout GRANT/REVOKE d'adhesion visant postgres
-- (connexion tuee) : l'adhesion SET est donc accordee IMPLICITEMENT a la creation
-- (createrole_self_grant, PG16+), sans aucun fallback GRANT explicite.
SET createrole_self_grant = 'set';

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_openai_native_maintenance_directory'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_openai_native_maintenance_directory'
) \gexec

DO $$
DECLARE
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
  owner_oid OID;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_openai_native_maintenance_directory';

  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = owner_oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_openai_native_maintenance_directory is not available through implicit SET membership; create it as this deployer with createrole_self_grant=set before retrying';
  END IF;
END;
$$;

ALTER ROLE bob_openai_native_maintenance_directory
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;

DO $$
DECLARE
  authority pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_openai_native_maintenance_directory';
  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION
      'OpenAI native maintenance directory role must remain least-privileged NOLOGIN';
  END IF;
END;
$$;

SELECT format(
  'REVOKE %I FROM %I CASCADE', parent_role.rolname,
  'bob_openai_native_maintenance_directory'
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent_role ON parent_role.oid = membership.roleid
 WHERE membership.member = 'bob_openai_native_maintenance_directory'::regrole
   AND parent_role.rolname <> 'postgres'
\gexec
SELECT format(
  'REVOKE %I FROM %I CASCADE',
  'bob_openai_native_maintenance_directory', member_role.rolname
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE membership.roleid = 'bob_openai_native_maintenance_directory'::regrole
   AND member_role.rolname NOT IN (current_user, 'postgres')
\gexec

DO $$
DECLARE
  owner_oid OID;
BEGIN
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_openai_native_maintenance_directory';

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = owner_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE membership.roleid = owner_oid
       AND member_role.rolname <> current_user
  ) THEN
    RAISE EXCEPTION
      'bob_openai_native_maintenance_directory has an unexpected member; membership remediation must be performed outside this release without targeting postgres';
  END IF;
END;
$$;
SQL
}

provision_openai_native_maintenance_directory() {
  ensure_openai_native_maintenance_directory_role
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
       'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
       'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
     )
       AND function.proowner NOT IN (
         (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user),
         'bob_openai_native_maintenance_directory'::regrole
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory function has an unexpected owner';
  END IF;
END;
$$;

GRANT CREATE ON SCHEMA public TO bob_openai_native_maintenance_directory;
SELECT format(
  'ALTER FUNCTION %s OWNER TO bob_openai_native_maintenance_directory',
  function.oid::regprocedure
)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
   'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
   'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec

SET LOCAL ROLE bob_openai_native_maintenance_directory;
REVOKE ALL ON FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(
  TEXT, INTEGER, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  FROM PUBLIC;
ALTER FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID)
  SECURITY DEFINER;
ALTER FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  SECURITY DEFINER;
ALTER FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  SECURITY DEFINER;
ALTER FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID)
  SET search_path = pg_catalog;
ALTER FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  SET search_path = pg_catalog;
ALTER FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  SET search_path = pg_catalog;
ALTER FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID)
  SET row_security = on;
ALTER FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  SET row_security = on;
ALTER FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  SET row_security = on;
ALTER FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID)
  SET statement_timeout = '4s';
ALTER FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  SET statement_timeout = '4s';
ALTER FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  SET statement_timeout = '4s';

-- Une default ACL historique ne doit jamais laisser un troisième rôle invoquer cette capacité
-- globale. Toute normalisation fonctionnelle reste sous le rôle owner NOLOGIN : le rituel marche
-- aussi avec un DIRECT_URL CREATEROLE/BYPASSRLS non-superuser.
SELECT format(
  'REVOKE ALL ON FUNCTION %s FROM %I CASCADE',
  function.oid::regprocedure,
  grantee_role.rolname
)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
 WHERE function.oid IN (
   'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
   'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
   'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
 )
   AND privilege.privilege_type = 'EXECUTE'
   AND privilege.grantee <> function.proowner
\gexec

SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I', function.oid::regprocedure, :'app_role')
  FROM pg_catalog.pg_proc AS function
 WHERE :'app_role' <> ''
   AND function.oid IN (
     'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
     'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
     'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
   )
\gexec
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM bob_openai_native_maintenance_directory;
GRANT USAGE ON SCHEMA public TO bob_openai_native_maintenance_directory;
REVOKE ALL ON TABLE public.realtime_native_speech_deliveries
  FROM bob_openai_native_maintenance_directory;
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE public.realtime_native_speech_deliveries FROM %s CASCADE',
  attribute.attname,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee_role.rolname) END
)
  FROM pg_catalog.pg_attribute AS attribute
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
 WHERE attribute.attrelid = 'public.realtime_native_speech_deliveries'::regclass
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
   AND attribute.attacl IS NOT NULL
\gexec
GRANT SELECT ("deliveryId", "companyId", phase, "expiresAt", "retentionExpiresAt")
  ON TABLE public.realtime_native_speech_deliveries
  TO bob_openai_native_maintenance_directory;

-- Exactement owner + directory au niveau table, aucune ACL colonne héritée. FORCE RLS a déjà
-- fermé l'éventuelle fenêtre N-1 dans la migration elle-même.
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES ON TABLE public.realtime_native_speech_maintenance_cursors FROM %s CASCADE',
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee_role.rolname) END
)
  FROM pg_catalog.pg_class AS relation
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
 WHERE relation.oid = 'public.realtime_native_speech_maintenance_cursors'::regclass
   AND privilege.grantee <> relation.relowner
\gexec
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE public.realtime_native_speech_maintenance_cursors FROM %s CASCADE',
  attribute.attname,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee_role.rolname) END
)
  FROM pg_catalog.pg_attribute AS attribute
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
 WHERE attribute.attrelid = 'public.realtime_native_speech_maintenance_cursors'::regclass
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
   AND attribute.attacl IS NOT NULL
\gexec
GRANT SELECT, UPDATE ON TABLE public.realtime_native_speech_maintenance_cursors
  TO bob_openai_native_maintenance_directory;

SELECT format(
  'REVOKE %I FROM %I CASCADE',
  owner_role.rolname, member_role.rolname
)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
 WHERE owner_role.rolname = 'bob_openai_native_maintenance_directory'
   AND member_role.rolname = :'app_role'
\gexec
SELECT pg_catalog.set_config('bob.openai_native_directory_app_role', :'app_role', true);
DO $$
DECLARE
  app_role_name TEXT := NULLIF(
    pg_catalog.current_setting('bob.openai_native_directory_app_role', true),
    ''
  );
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
       'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
       'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
     )
       AND (
         function.proowner <> 'bob_openai_native_maintenance_directory'::regrole
         OR NOT function.prosecdef
         OR function.proconfig IS DISTINCT FROM ARRAY[
           'search_path=pg_catalog', 'row_security=on', 'statement_timeout=4s'
         ]::TEXT[]
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory function authority drift';
  END IF;
  IF has_table_privilege(
       'bob_openai_native_maintenance_directory',
       'public.realtime_native_speech_deliveries',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory owns a mutation privilege';
  END IF;
  IF NOT has_table_privilege(
       'bob_openai_native_maintenance_directory',
       'public.realtime_native_speech_maintenance_cursors',
       'SELECT,UPDATE'
     )
     OR has_table_privilege(
       'bob_openai_native_maintenance_directory',
       'public.realtime_native_speech_maintenance_cursors',
       'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor privilege drift';
  END IF;
  IF app_role_name IS NOT NULL AND (
    NOT has_function_privilege(
      app_role_name,
      'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      app_role_name,
      'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      app_role_name,
      'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)',
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory is not executable by runtime';
  END IF;
  IF app_role_name IS NOT NULL AND has_table_privilege(
       app_role_name,
       'public.realtime_native_speech_maintenance_cursors',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'OpenAI native cursor table leaked to runtime';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
       'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
       'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
     )
       AND privilege.privilege_type = 'EXECUTE'
       AND privilege.grantee NOT IN (
         function.proowner,
         pg_catalog.to_regrole(app_role_name)
       )
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance directory function ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.realtime_native_speech_maintenance_cursors'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'OpenAI native maintenance cursor column ACL drift';
  END IF;
END;
$$;
SQL
}

ensure_realtime_reaper_directory_role() {
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
-- Supabase intercepte fatalement tout GRANT/REVOKE d'adhesion visant postgres
-- (connexion tuee) : l'adhesion SET est donc accordee IMPLICITEMENT a la creation
-- (createrole_self_grant, PG16+), sans aucun fallback GRANT explicite.
SET createrole_self_grant = 'set';

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'bob_realtime_reaper_directory'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_reaper_directory'
) \gexec

DO $$
DECLARE
  deployer_oid OID;
  deployer_is_superuser BOOLEAN;
  owner_oid OID;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT deployer_oid, deployer_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_realtime_reaper_directory';

  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET')
     OR (
       NOT deployer_is_superuser
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = owner_oid
            AND membership.member = deployer_oid
            AND membership.set_option
            AND NOT membership.inherit_option
       )
     ) THEN
    RAISE EXCEPTION
      'bob_realtime_reaper_directory is not available through implicit SET membership; create it as this deployer with createrole_self_grant=set before retrying';
  END IF;
END;
$$;

ALTER ROLE bob_realtime_reaper_directory
  NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

DO $$
DECLARE authority pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority
    FROM pg_catalog.pg_roles WHERE rolname = 'bob_realtime_reaper_directory';
  IF authority.rolcanlogin OR authority.rolsuper OR authority.rolcreatedb
     OR authority.rolcreaterole OR authority.rolinherit OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'Realtime reaper directory role privilege drift';
  END IF;
END;
$$;

SELECT format('REVOKE %I FROM %I CASCADE', parent.rolname, 'bob_realtime_reaper_directory')
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
 WHERE membership.member = 'bob_realtime_reaper_directory'::regrole
   AND parent.rolname <> 'postgres'
\gexec
SELECT format('REVOKE %I FROM %I CASCADE', 'bob_realtime_reaper_directory', member.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
 WHERE membership.roleid = 'bob_realtime_reaper_directory'::regrole
   AND member.rolname NOT IN (current_user, 'postgres')
\gexec

DO $$
DECLARE
  owner_oid OID;
BEGIN
  SELECT role.oid
    INTO STRICT owner_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'bob_realtime_reaper_directory';

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = owner_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
     WHERE membership.roleid = owner_oid
       AND member.rolname <> current_user
  ) THEN
    RAISE EXCEPTION
      'bob_realtime_reaper_directory has an unexpected member; membership remediation must be performed outside this release without targeting postgres';
  END IF;
END;
$$;
SQL
}

provision_realtime_reaper_directory() {
  ensure_realtime_reaper_directory_role
  psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
       'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
       'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure,
       'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
     )
       AND function.proowner NOT IN (
         (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user),
         'bob_realtime_reaper_directory'::regrole
       )
  ) THEN
    RAISE EXCEPTION 'Realtime reaper directory function has an unexpected owner';
  END IF;
END;
$$;

GRANT USAGE, CREATE ON SCHEMA public TO bob_realtime_reaper_directory;
SELECT format('ALTER FUNCTION %s OWNER TO bob_realtime_reaper_directory', function.oid::regprocedure)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
   'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
   'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure,
   'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
\gexec

SET LOCAL ROLE bob_realtime_reaper_directory;
REVOKE ALL ON FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() FROM PUBLIC;
ALTER FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID) SECURITY DEFINER;
ALTER FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) SECURITY DEFINER;
ALTER FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) SECURITY DEFINER;
ALTER FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() SECURITY DEFINER;
ALTER FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID)
  SET search_path = pg_catalog;
ALTER FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) SET search_path = pg_catalog;
ALTER FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) SET search_path = pg_catalog;
ALTER FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() SET search_path = pg_catalog;
ALTER FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID) SET row_security = on;
ALTER FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) SET row_security = on;
ALTER FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) SET row_security = on;
ALTER FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() SET row_security = on;
ALTER FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID)
  SET statement_timeout = '4s';
ALTER FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) SET statement_timeout = '4s';
ALTER FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID)
  SET statement_timeout = '4s';
ALTER FUNCTION public.sync_realtime_reaper_tenant_schedule_v1()
  SET statement_timeout = '4s';
ALTER FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID) SET lock_timeout = '1s';
ALTER FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) SET lock_timeout = '1s';
ALTER FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) SET lock_timeout = '1s';
ALTER FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() SET lock_timeout = '1s';

SELECT format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',
              function.oid::regprocedure, grantee.rolname)
  FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
 ) AS privilege
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
   'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
   'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure,
   'public.sync_realtime_reaper_tenant_schedule_v1()'::regprocedure
 )
   AND privilege.privilege_type = 'EXECUTE'
   AND privilege.grantee <> function.proowner
\gexec
SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I', function.oid::regprocedure, :'app_role')
  FROM pg_catalog.pg_proc AS function
 WHERE :'app_role' <> ''
   AND function.oid IN (
     'public.list_realtime_reaper_tenants_v1(integer,uuid)'::regprocedure,
     'public.ack_realtime_reaper_tenants_v1(uuid)'::regprocedure,
     'public.renew_realtime_reaper_tenants_claim_v1(uuid)'::regprocedure
   )
\gexec
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM bob_realtime_reaper_directory;
GRANT USAGE ON SCHEMA public TO bob_realtime_reaper_directory;
REVOKE ALL ON TABLE public.realtime_admission_events FROM bob_realtime_reaper_directory;
REVOKE ALL ON TABLE public.realtime_session_leases FROM bob_realtime_reaper_directory;
REVOKE ALL ON TABLE public.realtime_mistral_conversation_bootstrap_tickets
  FROM bob_realtime_reaper_directory;
REVOKE ALL ON TABLE public.realtime_mistral_conversation_missions
  FROM bob_realtime_reaper_directory;
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM bob_realtime_reaper_directory CASCADE',
  attribute.attname, attribute.attrelid::regclass
)
  FROM pg_catalog.pg_attribute AS attribute
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
 WHERE attribute.attrelid IN (
   'public.realtime_admission_events'::regclass,
   'public.realtime_session_leases'::regclass,
   'public.realtime_mistral_conversation_bootstrap_tickets'::regclass,
   'public.realtime_mistral_conversation_missions'::regclass
 )
   AND attribute.attnum > 0 AND NOT attribute.attisdropped
   AND privilege.grantee = 'bob_realtime_reaper_directory'::regrole
\gexec
-- Le rôle global ne voit plus aucune source tenantée. Les triggers ne font qu'abaisser la
-- projection depuis leurs transition tables ; la réconciliation exacte reste tenantée.

SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES ON TABLE public.realtime_reaper_tenant_schedule FROM %s CASCADE',
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END
)
  FROM pg_catalog.pg_class AS relation
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass
   AND privilege.grantee <> relation.relowner
\gexec
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE public.realtime_reaper_tenant_schedule FROM %s CASCADE',
  attribute.attname,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END
)
  FROM pg_catalog.pg_attribute AS attribute
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE attribute.attrelid = 'public.realtime_reaper_tenant_schedule'::regclass
   AND attribute.attnum > 0 AND NOT attribute.attisdropped
   AND attribute.attacl IS NOT NULL
\gexec
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.realtime_reaper_tenant_schedule TO bob_realtime_reaper_directory;
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.realtime_reaper_tenant_schedule TO %I',
  :'app_role'
)
 WHERE :'app_role' <> ''
\gexec

SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES ON TABLE public.realtime_reaper_directory_cursor FROM %s CASCADE',
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END
)
  FROM pg_catalog.pg_class AS relation
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE relation.oid = 'public.realtime_reaper_directory_cursor'::regclass
   AND privilege.grantee <> relation.relowner
\gexec
SELECT DISTINCT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE public.realtime_reaper_directory_cursor FROM %s CASCADE',
  attribute.attname,
  CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END
)
  FROM pg_catalog.pg_attribute AS attribute
 CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
 WHERE attribute.attrelid = 'public.realtime_reaper_directory_cursor'::regclass
   AND attribute.attnum > 0 AND NOT attribute.attisdropped
   AND attribute.attacl IS NOT NULL
\gexec
GRANT SELECT, UPDATE ON TABLE public.realtime_reaper_directory_cursor
  TO bob_realtime_reaper_directory;

SELECT format('REVOKE %I FROM %I CASCADE', owner.rolname, member.rolname)
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
 WHERE owner.rolname = 'bob_realtime_reaper_directory'
   AND member.rolname = :'app_role'
\gexec
SQL
}

certify_realtime_reaper_release_metadata() {
  psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -v app_role="${APP_DATABASE_ROLE:-}" \
    -f apps/api/prisma/realtime-reaper-release-cert.sql
}

certify_cabinet_worker_scope() {
  : "${CABINET_RELEASE_ENV:?CABINET_RELEASE_ENV is required}"
  : "${CABINET_INVITATION_WORKER_ENABLED:?CABINET_INVITATION_WORKER_ENABLED is required}"
  local_job_ids="${JOB_CABINET_IDS:-}"
  local_worker_id="${CABINET_INVITATION_WORKER_USER_ID:-}"
  distinct_job_count="$(printf '%s' "$local_job_ids" | tr ',' '\n' | awk '
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "") }
    NF && !seen[$0]++ { count += 1 }
    END { print count + 0 }
  ')"
  if [ "$distinct_job_count" -gt 100 ]; then
    echo "JOB_CABINET_IDS is limited to 100 distinct pilot cabinets" >&2
    return 1
  fi
  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    if [ -z "$local_job_ids" ] || [ -z "$local_worker_id" ]; then
      echo "enabled Cabinet worker requires JOB_CABINET_IDS and CABINET_INVITATION_WORKER_USER_ID" >&2
      return 1
    fi
  elif [ "$CABINET_INVITATION_WORKER_ENABLED" = "false" ]; then
    local_job_ids=""
    local_worker_id=""
  else
    echo "CABINET_INVITATION_WORKER_ENABLED must be true or false" >&2
    return 1
  fi

  invalid_global="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 -v release_env="$CABINET_RELEASE_ENV" <<'SQL'
SELECT count(*) FROM release_flags
 WHERE key = 'cabinet.slice0'
   AND environment = :'release_env'::"ReleaseEnvironment"
   AND enabled = true;
SQL
)"
  if [ "$invalid_global" != "0" ]; then
    echo "cabinet.slice0 global enablement is forbidden while outbox retention is pilot-scoped" >&2
    return 1
  fi

  invalid_targets="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -v release_env="$CABINET_RELEASE_ENV" -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM release_flag_subjects subject
  JOIN release_flags flag ON flag.id = subject."flagId"
 WHERE flag.key = 'cabinet.slice0'
   AND flag.environment = :'release_env'::"ReleaseEnvironment"
   AND subject.enabled = true
   AND (
     subject."subjectType" <> 'cabinet'
     OR NOT (subject."subjectId" = ANY(string_to_array(:'job_ids', ',')))
     OR NOT EXISTS (
       SELECT 1 FROM cabinets cabinet
       JOIN cabinet_members member ON member."cabinetId" = cabinet.id
        WHERE cabinet.id = subject."subjectId"
          AND cabinet.status = 'active'
          AND member."userId" = :'worker_id'
          AND member.role = 'admin'
          AND member.status = 'active'
     )
   );
SQL
)"
  if [ "$invalid_targets" != "0" ]; then
    echo "enabled cabinet pilots must be worker-covered cabinets with an active service admin" >&2
    return 1
  fi

  if [ "$CABINET_INVITATION_WORKER_ENABLED" = "true" ]; then
    invalid_jobs="$(psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
      -v job_ids="$local_job_ids" -v worker_id="$local_worker_id" <<'SQL'
SELECT count(*)
  FROM unnest(string_to_array(:'job_ids', ',')) AS configured("cabinetId")
 WHERE btrim(configured."cabinetId") <> ''
   AND NOT EXISTS (
     SELECT 1 FROM cabinets cabinet
     JOIN cabinet_members member ON member."cabinetId" = cabinet.id
      WHERE cabinet.id = btrim(configured."cabinetId")
        AND cabinet.status = 'active'
        AND member."userId" = :'worker_id'
        AND member.role = 'admin'
        AND member.status = 'active'
   );
SQL
)"
    if [ "$invalid_jobs" != "0" ]; then
      echo "every JOB_CABINET_IDS entry requires an active ADMIN worker membership" >&2
      return 1
    fi
  fi
}

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

node apps/api/scripts/assert-database-pair.mjs
node --test \
  apps/api/scripts/assert-database-pair.test.mjs \
  apps/api/scripts/assert-migration-lineage.test.mjs \
  apps/api/scripts/assert-applied-migration-checksums.test.mjs
# Avant la première mutation, toute migration déjà appliquée doit encore correspondre octet pour
# octet au dépôt. Les nouveaux fichiers locaux sont attendus jusqu'au migrate deploy.
node apps/api/scripts/assert-applied-migration-checksums.mjs --allow-pending-local

# Ne jamais installer l'expand qui gèle les sorties historiques si des factures émises n'ont pas
# encore reçu une audience revue. Le contrôle est volontairement antérieur à toute mutation de
# rôle ou de schéma de ce train.
sh apps/api/scripts/check-document-archive-legacy-audience.sh
pnpm --filter '@bob/api...' run build

# Révoque tout ancien SET ROLE runtime avant même que la migration SECURITY DEFINER soit visible.
ensure_mistral_bootstrap_reaper_role
ensure_openai_native_maintenance_directory_role
ensure_realtime_reaper_directory_role
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/realtime-capacity-release.sh ensure
# Adhesion implicite du createur sur tout role cree par les migrations (Supabase tue
# la connexion sur un GRANT d'adhesion explicite vers postgres). Reglage base, idempotent.
psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT format('ALTER DATABASE %I SET createrole_self_grant = %L', current_database(), 'set')" \
  | psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1

pnpm --filter @bob/api exec prisma migrate deploy
node apps/api/scripts/assert-applied-migration-checksums.mjs
certify_openai_native_legacy_gate_pregrant
certify_generated_legal_storage_fence
provision_mistral_bootstrap_reaper
node apps/api/scripts/manage-mistral-conversation-key-version.mjs stage
node apps/api/scripts/manage-bob-live-native-key-versions.mjs stage
grant_app_role
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f apps/api/prisma/rls.sql
certify_agent_mission_release_acl
provision_openai_native_maintenance_directory
provision_realtime_reaper_directory
DIRECT_URL="$DIRECT_URL" APP_DATABASE_ROLE="${APP_DATABASE_ROLE:-}" \
  sh apps/api/scripts/realtime-capacity-release.sh provision
# Toute la suite de certification s'exécute admissions fermées. Un échec ne peut donc jamais
# laisser une autorité active après une release incomplète ; l'activation réelle est le dernier
# geste atomique, après retrait des fixtures et de leurs traps.
DIRECT_URL="$DIRECT_URL" BOB_LIVE_ENABLED=false OPENAI_REALTIME_ENABLED=false \
  sh apps/api/scripts/realtime-capacity-release.sh configure
certify_openai_native_release_metadata
certify_realtime_reaper_release_metadata
certify_realtime_global_capacity_release_metadata
certify_document_archive_evidence_privacy

trap cleanup_release_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup_rls_cert
node apps/api/scripts/bootstrap-cabinet-pilots.mjs
certify_cabinet_worker_scope
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-cabinet-concurrency.sh
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/certify-release-flag-ops.sh
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert-cabinet-seed.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/rls-cert.sql
psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f apps/api/prisma/cabinet-rls-cert-privileged.sql
RUN_POSTGRES_DEVICE_REBIND_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/devices.postgres.test.ts
RUN_POSTGRES_CATALOGUE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/catalogue-chantiers.postgres.test.ts
RUN_POSTGRES_QUOTE_DRAFT_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/quote-draft-slots.postgres.test.ts
RUN_POSTGRES_EXPENSE_PAYMENT_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/expense-payment-evidence.postgres.test.ts
RUN_POSTGRES_BILLING_SETTINGS_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/company-billing-settings.postgres.test.ts
RUN_POSTGRES_COMPANY_MUTATION_LIFECYCLE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/company-mutation-lifecycle.postgres.test.ts
RUN_POSTGRES_QUOTE_SIGNATURE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/quote-signature-token-concurrency.postgres.test.ts
RUN_POSTGRES_PUBLIC_CAPABILITY_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/public-capability-lifecycle.postgres.test.ts
RUN_POSTGRES_INVOICE_ISSUE_LIFECYCLE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/invoice-issue-lifecycle.postgres.test.ts
certify_document_archive_protocol
RUN_POSTGRES_CREDIT_NOTE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/credit-note-traceability.postgres.test.ts
certify_invoice_settlement_protocol
RUN_POSTGRES_STRIPE_INVOICES_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 src/persistence/prisma/stripe-subscription-invoices.postgres.test.ts
RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT=false \
RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT=false \
DATABASE_URL="$DATABASE_URL" DIRECT_URL="$DIRECT_URL" \
  sh apps/api/scripts/certify-mistral-conversation-authority.sh
cleanup_rls_cert
trap - EXIT HUP INT TERM

# Dernier geste de la release : active la configuration exacte demandée, ou laisse explicitement
# l'autorité fermée. Aucun test susceptible d'échouer n'est exécuté après cette transition.
DIRECT_URL="$DIRECT_URL" sh apps/api/scripts/realtime-capacity-release.sh configure
echo "Bob Pro API release checks passed"
