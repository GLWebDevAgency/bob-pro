-- Archive V2 — clôture explicite de la surface Supabase Data API.
--
-- PostgreSQL accorde EXECUTE à PUBLIC par défaut et certains projets Supabase existants ont aussi
-- des default privileges explicites pour anon/authenticated/service_role. Les migrations sources
-- révoquent PUBLIC au fil de l'eau ; ce rail final certifie l'inventaire exact et retire également
-- les grants historiques des rôles Data API. release.sh réaccorde ensuite uniquement les capacités
-- runtime bornées au rôle applicatif dédié.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $$
DECLARE
  expected_names CONSTANT TEXT[] := ARRAY[
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
  actual_count INTEGER;
  archive_function RECORD;
  exposed_role TEXT;
BEGIN
  SELECT count(*)::INTEGER
    INTO actual_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.prokind = 'f'
     AND procedure.proname = ANY(expected_names);

  IF actual_count <> cardinality(expected_names) THEN
    RAISE EXCEPTION
      'archive RPC inventory drift: expected % functions, found %',
      cardinality(expected_names), actual_count;
  END IF;

  FOR archive_function IN
    SELECT namespace.nspname,
           procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.prokind = 'f'
       AND procedure.proname = ANY(expected_names)
     ORDER BY procedure.proname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC',
      archive_function.nspname,
      archive_function.proname,
      archive_function.identity_arguments
    );
    FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
      IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
          archive_function.nspname,
          archive_function.proname,
          archive_function.identity_arguments,
          exposed_role
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
