-- Bob Pro — Row Level Security (défense en profondeur multi-tenant).
-- Tenant courant = current_setting('app.current_company_id'). L'app doit le poser par requête
-- (SET LOCAL app.current_company_id = '<companyId>' dans une transaction) et se connecter avec
-- un rôle applicatif. FORCE garantit que même le propriétaire de la table est soumis aux politiques.
-- À exécuter après les migrations Prisma :
-- psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f prisma/rls.sql

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  table_names TEXT[] := ARRAY[
    'companies',
    'company_billing_settings',
    'company_diagnostic_assessments',
    'customers',
    'customer_contacts',
    'quotes',
    'invoices',
    'invoice_predecessors',
    'line_items',
    'payments',
    'public_access_tokens',
    'expenses',
    'expense_creation_requests',
    'quote_creation_requests',
    'quote_draft_slots',
    'agent_missions',
    'agent_mission_events',
    'agent_mission_quote_line_work',
    'agent_mission_fingerprint_key_version_floors',
    'agent_mission_fingerprint_key_bindings',
    'jarvis_work_items',
    'jarvis_dispatch_directory_cursors',
    'jarvis_proposal_payloads',
    'documents',
    'document_analyses',
    'document_folders',
    'document_folder_deletion_plans',
    'document_versions',
    'document_invoice_pdf_attestations',
    'document_archive_jobs',
    'document_archive_job_artifacts',
    'document_archive_render_snapshots',
    'document_archive_artifact_intents',
    'document_archive_snapshot_protocol_state',
    'document_archive_quarantine_operations',
    'document_archive_quarantine_entries',
    'document_archive_quarantine_events',
    'notification_jobs',
    'devices',
    'push_installations',
    'agent_journal_entries',
    'accounting_accounts',
    'accounting_entries',
    'accounting_entry_lines',
    'supplier_memory_profiles',
    'bank_balance_snapshots',
    'catalogue_prestations',
    'catalogue_prestation_search_tokens',
    'chantiers',
    'chantier_notes',
    'chantier_photos',
    'equipments',
    'maintenance_contracts',
    'maintenance_contract_lines',
    'maintenance_contract_equipments',
    'interventions',
    'company_intervention_settings',
    'subscriptions',
    'fiscal_profiles',
    'document_counters',
    'realtime_admission_events',
    'realtime_admission_cancellation_fences',
    'realtime_session_leases',
    'realtime_reaper_tenant_schedule',
    'realtime_mistral_ingress_tickets',
    'realtime_mistral_conversation_bootstrap_tickets',
    'realtime_mistral_conversation_missions',
    'realtime_mistral_conversation_terminal_receipts',
    'realtime_mistral_conversation_resume_tickets',
    'realtime_mistral_conversation_outbox',
    'realtime_mistral_conversation_commands',
    'realtime_mistral_conversation_key_version_floors',
    'realtime_mistral_conversation_key_bindings',
    'realtime_mistral_conversation_identity_key_version_floors',
    'realtime_mistral_conversation_identity_key_bindings',
    'realtime_speech_artifacts',
    'realtime_native_speech_deliveries',
    'realtime_control_grants',
    'realtime_control_consumptions',
    'realtime_voice_usage_events',
    'realtime_voice_usage_daily',
    'voice_traces',
    'realtime_voice_trace_events',
    'realtime_voice_trace_access_audits',
    'cabinets',
    'cabinet_members',
    'cabinet_admin_guards',
    'cabinet_invitations',
    'cabinet_invitation_deliveries',
    'cabinet_dossiers',
    'cabinet_audit_events',
    'release_flags',
    'release_flag_subjects',
    'release_flag_audit_events'
  ]::TEXT[];
  t TEXT;
  found_table_count INTEGER;
  owner_oids OID[];
  rls_owner_name TEXT;
BEGIN
  SELECT pg_catalog.count(*),
         pg_catalog.array_agg(DISTINCT relation.relowner)
    INTO found_table_count, owner_oids
    FROM pg_catalog.pg_class AS relation
   WHERE relation.relnamespace = 'public'::pg_catalog.regnamespace
     AND relation.relkind IN ('r', 'p')
     AND relation.relname = ANY (table_names);

  IF found_table_count <> pg_catalog.cardinality(table_names)
     OR pg_catalog.cardinality(owner_oids) <> 1 THEN
    RAISE EXCEPTION
      'RLS replay requires every protected table to exist under one exact schema owner';
  END IF;
  rls_owner_name := pg_catalog.pg_get_userbyid(owner_oids[1]);
  IF rls_owner_name IS NULL
     OR NOT pg_catalog.pg_has_role(
       session_user,
       owner_oids[1],
       'SET'
     ) THEN
    RAISE EXCEPTION
      'RLS replay schema owner is not available through SET ROLE to the deployer';
  END IF;

  PERFORM pg_catalog.set_config(
    'bob.release.rls_owner_role',
    rls_owner_name,
    TRUE
  );
  EXECUTE pg_catalog.format('SET LOCAL ROLE %I', rls_owner_name);

  FOREACH t IN ARRAY table_names LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      t
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON companies;
DROP POLICY IF EXISTS company_select ON companies;
DROP POLICY IF EXISTS company_insert ON companies;
DROP POLICY IF EXISTS company_update ON companies;
CREATE POLICY company_select ON companies FOR SELECT
  USING (id = current_setting('app.current_company_id', true));
CREATE POLICY company_insert ON companies FOR INSERT
  WITH CHECK (id = current_setting('app.current_company_id', true));
CREATE POLICY company_update ON companies FOR UPDATE
  USING (id = current_setting('app.current_company_id', true))
  WITH CHECK (id = current_setting('app.current_company_id', true));
-- Aucune policy DELETE : une Company est clôturée de façon monotone, jamais hard-deleted par le
-- runtime. release.sh retire aussi le privilège SQL pour que policy et GRANT se défendent ensemble.

-- Les réglages sont immuables en identité (companyId) et ne peuvent jamais être supprimés par le
-- runtime. Le PATCH applicatif fait un CAS sur revision ; RLS reste la défense inter-tenant.
DROP POLICY IF EXISTS tenant_isolation ON company_billing_settings;
DROP POLICY IF EXISTS company_billing_settings_select ON company_billing_settings;
DROP POLICY IF EXISTS company_billing_settings_insert ON company_billing_settings;
DROP POLICY IF EXISTS company_billing_settings_update ON company_billing_settings;
CREATE POLICY company_billing_settings_select ON company_billing_settings FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_billing_settings_insert ON company_billing_settings FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_billing_settings_update ON company_billing_settings FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Un seul résultat terminé par société. Pas de DELETE runtime : l'historique courant est mis à
-- jour uniquement par CAS et reste conservé lors de la clôture du compte.
DROP POLICY IF EXISTS tenant_isolation ON company_diagnostic_assessments;
DROP POLICY IF EXISTS company_diagnostic_assessment_select ON company_diagnostic_assessments;
DROP POLICY IF EXISTS company_diagnostic_assessment_insert ON company_diagnostic_assessments;
DROP POLICY IF EXISTS company_diagnostic_assessment_update ON company_diagnostic_assessments;
CREATE POLICY company_diagnostic_assessment_select ON company_diagnostic_assessments FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_diagnostic_assessment_insert ON company_diagnostic_assessments FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY company_diagnostic_assessment_update ON company_diagnostic_assessments FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON customer_contacts;
CREATE POLICY tenant_isolation ON customer_contacts
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON bank_balance_snapshots;
DROP POLICY IF EXISTS bank_balance_snapshot_select ON bank_balance_snapshots;
DROP POLICY IF EXISTS bank_balance_snapshot_insert ON bank_balance_snapshots;
CREATE POLICY bank_balance_snapshot_select ON bank_balance_snapshots FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY bank_balance_snapshot_insert ON bank_balance_snapshots FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Un brouillon est plus fin que le tenant : seul le propriétaire JWT courant peut le lire ou
-- l'écrire. Le backend doit poser les deux GUC dans la même transaction avant toute requête.
DROP POLICY IF EXISTS tenant_isolation ON quote_draft_slots;
DROP POLICY IF EXISTS quote_draft_slot_owner_select ON quote_draft_slots;
DROP POLICY IF EXISTS quote_draft_slot_owner_insert ON quote_draft_slots;
DROP POLICY IF EXISTS quote_draft_slot_owner_update ON quote_draft_slots;
DROP POLICY IF EXISTS quote_draft_slot_owner_delete ON quote_draft_slots;
CREATE POLICY quote_draft_slot_owner_select ON quote_draft_slots FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_insert ON quote_draft_slots FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_update ON quote_draft_slots FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_delete ON quote_draft_slots FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );

-- Les missions sont plus fines que le tenant : société + propriétaire JWT, puis capability
-- interne exacte pour les INSERT/UPDATE. Les événements restent append-only.
DROP POLICY IF EXISTS agent_missions_owner_select ON agent_missions;
DROP POLICY IF EXISTS agent_missions_owner_insert ON agent_missions;
DROP POLICY IF EXISTS agent_missions_owner_update ON agent_missions;
CREATE POLICY agent_missions_owner_select ON agent_missions FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY agent_missions_owner_insert ON agent_missions FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY agent_missions_owner_update ON agent_missions FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

DROP POLICY IF EXISTS jarvis_proposal_payloads_owner_select ON jarvis_proposal_payloads;
DROP POLICY IF EXISTS jarvis_proposal_payloads_owner_insert ON jarvis_proposal_payloads;
DROP POLICY IF EXISTS jarvis_proposal_payloads_retention_delete ON jarvis_proposal_payloads;
CREATE POLICY jarvis_proposal_payloads_owner_select ON jarvis_proposal_payloads FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
-- Écriture épinglée au run courant (patron jarvis_work_items) ; AUCUNE policy UPDATE :
-- un payload scellé est immuable, une correction est une nouvelle proposition. DELETE borné
-- à la rétention échue sous les mêmes GUC owner — le droit d'effacer ne vaut que pour du PII
-- périmé (§5.5).
CREATE POLICY jarvis_proposal_payloads_owner_insert ON jarvis_proposal_payloads FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY jarvis_proposal_payloads_retention_delete ON jarvis_proposal_payloads FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "retentionExpiresAt" <= statement_timestamp()
  );

DROP POLICY IF EXISTS jarvis_work_items_owner_select ON jarvis_work_items;
DROP POLICY IF EXISTS jarvis_work_items_owner_insert ON jarvis_work_items;
DROP POLICY IF EXISTS jarvis_work_items_owner_update ON jarvis_work_items;
CREATE POLICY jarvis_work_items_owner_select ON jarvis_work_items FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY jarvis_work_items_owner_insert ON jarvis_work_items FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY jarvis_work_items_owner_update ON jarvis_work_items FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

-- Annuaire global minimal U1-l. La policy source reste une pré-borne conservative : les quatre
-- fonctions v2 ajoutent leur cutoff figé sans jamais contourner FORCE RLS.
DROP POLICY IF EXISTS jarvis_work_items_dispatch_directory_select ON jarvis_work_items;
CREATE POLICY jarvis_work_items_dispatch_directory_select ON jarvis_work_items FOR SELECT
  USING (
    current_user = 'bob_jarvis_dispatch_directory'
    AND (
      (
        "status" IN ('prepared', 'retry_due')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= statement_timestamp())
      )
      OR (
        "status" = 'leased'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < statement_timestamp()
      )
      OR (
        "status" = 'authorized'
        AND "resultDigest" IS NULL
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < statement_timestamp()
      )
      OR (
        "status" IN ('succeeded', 'failed_terminal', 'cancelled')
        AND "resultDigest" IS NOT NULL
        AND "signalAppliedAt" IS NULL
        AND (
          "status" <> 'succeeded'
          OR ("authorizedAt" IS NOT NULL AND "authorizationDigest" IS NOT NULL)
        )
        AND (
          "status" <> 'cancelled'
          OR ("authorizedAt" IS NULL AND "authorizationDigest" IS NULL)
        )
      )
    )
  );

REVOKE ALL ON TABLE public.jarvis_dispatch_directory_cursors FROM PUBLIC;
DROP POLICY IF EXISTS jarvis_dispatch_directory_cursors_select
  ON public.jarvis_dispatch_directory_cursors;
DROP POLICY IF EXISTS jarvis_dispatch_directory_cursors_insert
  ON public.jarvis_dispatch_directory_cursors;
DROP POLICY IF EXISTS jarvis_dispatch_directory_cursors_update
  ON public.jarvis_dispatch_directory_cursors;
CREATE POLICY jarvis_dispatch_directory_cursors_select
  ON public.jarvis_dispatch_directory_cursors FOR SELECT
  USING (current_user = 'bob_jarvis_dispatch_directory');
CREATE POLICY jarvis_dispatch_directory_cursors_insert
  ON public.jarvis_dispatch_directory_cursors FOR INSERT
  WITH CHECK (current_user = 'bob_jarvis_dispatch_directory');
CREATE POLICY jarvis_dispatch_directory_cursors_update
  ON public.jarvis_dispatch_directory_cursors FOR UPDATE
  USING (current_user = 'bob_jarvis_dispatch_directory')
  WITH CHECK (current_user = 'bob_jarvis_dispatch_directory');

DO $jarvis_dispatch_directory_exposed_tables$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.jarvis_dispatch_directory_cursors FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$jarvis_dispatch_directory_exposed_tables$;

-- Les fonctions peuvent appartenir au deployer (première release) ou déjà à l'autorité NOLOGIN
-- (replay). On révoque PUBLIC/Data API sous leur owner exact, puis on revient au schema owner ; le
-- provisioner qui suit conserve EXECUTE v1 pour N-1 et accorde les quatre gestes v2 au runtime.
DO $jarvis_dispatch_directory_function_owner$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::regprocedure,
       'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::regprocedure,
       'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::regprocedure,
       'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::regprocedure,
       'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::regprocedure
     )
       AND function.proowner <> (
         SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user
       )
       AND NOT pg_catalog.pg_has_role(session_user, function.proowner, 'SET')
  ) THEN
    RAISE EXCEPTION
      'Jarvis dispatch directory function has an unexpected owner during RLS replay';
  END IF;
END;
$jarvis_dispatch_directory_function_owner$;
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::regprocedure,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid IN (
   'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::regprocedure,
   'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::regprocedure,
   'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::regprocedure,
   'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::regprocedure,
   'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::regprocedure
 )
\gexec
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::regprocedure,
  exposed_role.rolname,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid IN (
   'public.list_jarvis_dispatch_coordinates_v1(text,integer)'::regprocedure,
   'public.claim_jarvis_dispatch_coordinates_v2(text,integer,uuid)'::regprocedure,
   'public.renew_jarvis_dispatch_coordinates_claim_v2(text,uuid)'::regprocedure,
   'public.start_jarvis_dispatch_coordinate_v2(text,uuid,integer)'::regprocedure,
   'public.ack_jarvis_dispatch_coordinates_v2(text,uuid)'::regprocedure
 )
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

DROP POLICY IF EXISTS agent_mission_events_owner_select ON agent_mission_events;
DROP POLICY IF EXISTS agent_mission_events_owner_insert ON agent_mission_events;
CREATE POLICY agent_mission_events_owner_select ON agent_mission_events FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY agent_mission_events_owner_insert ON agent_mission_events FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

-- Les faits de ligne non confirmés appartiennent à la même capability mission que leur parent.
-- Le rejeu RLS doit conserver exactement les quatre policies de la migration M2-A : une lecture
-- owner/tenant et trois mutations également fencées par l'identifiant de mission courant.
DROP POLICY IF EXISTS agent_mission_quote_line_work_owner_select
  ON agent_mission_quote_line_work;
DROP POLICY IF EXISTS agent_mission_quote_line_work_owner_insert
  ON agent_mission_quote_line_work;
DROP POLICY IF EXISTS agent_mission_quote_line_work_owner_update
  ON agent_mission_quote_line_work;
DROP POLICY IF EXISTS agent_mission_quote_line_work_owner_delete
  ON agent_mission_quote_line_work;
CREATE POLICY agent_mission_quote_line_work_owner_select
  ON agent_mission_quote_line_work FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY agent_mission_quote_line_work_owner_insert
  ON agent_mission_quote_line_work FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::text =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY agent_mission_quote_line_work_owner_update
  ON agent_mission_quote_line_work FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::text =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::text =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY agent_mission_quote_line_work_owner_delete
  ON agent_mission_quote_line_work FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::text =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );

REVOKE ALL ON TABLE agent_missions FROM PUBLIC;
REVOKE ALL ON TABLE agent_mission_events FROM PUBLIC;
REVOKE ALL ON TABLE agent_mission_quote_line_work FROM PUBLIC;
REVOKE ALL ON TABLE catalogue_prestations FROM PUBLIC;
REVOKE ALL ON TABLE catalogue_prestation_search_tokens FROM PUBLIC;
REVOKE ALL ON TABLE agent_mission_fingerprint_key_version_floors FROM PUBLIC;
REVOKE ALL ON TABLE agent_mission_fingerprint_key_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_agent_mission_mutation_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_quote_draft_agent_mission_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_agent_mission_quote_line_work_v3() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_agent_mission_event_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_agent_mission_event_append_v3() FROM PUBLIC;
REVOKE ALL ON FUNCTION require_agent_mission_event_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_catalogue_prestation_revision_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_agent_mission_fingerprint_key_floor_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_agent_mission_fingerprint_key_binding_immutable_v1() FROM PUBLIC;

-- Après la première release, ces fonctions appartiennent à des autorités NOLOGIN dédiées.
-- Le rejeu RLS doit donc révoquer sous leur propriétaire exact : le déployeur Supabase n'hérite
-- volontairement pas de ces rôles et une révocation directe casserait la deuxième release.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid IN (
   'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure,
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure,
   'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure
 )
 ORDER BY function.oid
\gexec

DO $$
DECLARE
  exposed_role text;
  column_name text;
BEGIN
  FOR column_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.catalogue_prestations'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
     ORDER BY attribute.attnum
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE catalogue_prestations FROM PUBLIC',
      column_name,
      column_name,
      column_name,
      column_name
    );
  END LOOP;

  FOR column_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
           'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
     ORDER BY attribute.attnum
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE catalogue_prestation_search_tokens FROM PUBLIC',
      column_name,
      column_name,
      column_name,
      column_name
    );
  END LOOP;

  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::text[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE agent_missions FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE agent_mission_events FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE agent_mission_quote_line_work FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE catalogue_prestations FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE catalogue_prestation_search_tokens FROM %I',
        exposed_role
      );
      FOR column_name IN
        SELECT attribute.attname
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.catalogue_prestations'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attacl IS NOT NULL
         ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE catalogue_prestations FROM %I',
          column_name,
          column_name,
          column_name,
          column_name,
          exposed_role
        );
      END LOOP;
      FOR column_name IN
        SELECT attribute.attname
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid =
               'public.catalogue_prestation_search_tokens'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attacl IS NOT NULL
         ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE catalogue_prestation_search_tokens FROM %I',
          column_name,
          column_name,
          column_name,
          column_name,
          exposed_role
        );
      END LOOP;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE agent_mission_fingerprint_key_version_floors FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE agent_mission_fingerprint_key_bindings FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_mutation_v2() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_quote_draft_agent_mission_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_quote_line_work_v3() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION reject_agent_mission_event_mutation_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_event_append_v3() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION require_agent_mission_event_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_catalogue_prestation_revision_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_fingerprint_key_floor_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_mission_fingerprint_key_binding_immutable_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  exposed_role.rolname,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid IN (
   'public.sync_catalogue_prestation_search_tokens_v1()'::pg_catalog.regprocedure,
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure,
   'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure
 )
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY function.oid, exposed_role.rolname
\gexec

DROP POLICY IF EXISTS tenant_isolation ON catalogue_prestations;
CREATE POLICY tenant_isolation ON catalogue_prestations
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON catalogue_prestation_search_tokens;
CREATE POLICY tenant_isolation ON catalogue_prestation_search_tokens
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON chantiers;
CREATE POLICY tenant_isolation ON chantiers
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON chantier_notes;
CREATE POLICY tenant_isolation ON chantier_notes
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON chantier_photos;
CREATE POLICY tenant_isolation ON chantier_photos
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON equipments;
CREATE POLICY tenant_isolation ON equipments
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON maintenance_contracts;
CREATE POLICY tenant_isolation ON maintenance_contracts
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON maintenance_contract_lines;
CREATE POLICY tenant_isolation ON maintenance_contract_lines
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON maintenance_contract_equipments;
CREATE POLICY tenant_isolation ON maintenance_contract_equipments
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON interventions;
CREATE POLICY tenant_isolation ON interventions
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON company_intervention_settings;
CREATE POLICY tenant_isolation ON company_intervention_settings
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON quotes;
CREATE POLICY tenant_isolation ON quotes
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON invoices;
DROP POLICY IF EXISTS invoice_select ON invoices;
DROP POLICY IF EXISTS invoice_insert ON invoices;
DROP POLICY IF EXISTS invoice_update ON invoices;
DROP POLICY IF EXISTS invoice_delete_draft ON invoices;
CREATE POLICY invoice_select ON invoices FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY invoice_insert ON invoices FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY invoice_update ON invoices FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY invoice_delete_draft ON invoices FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND status = 'draft'
  );

-- Références de pièces antérieures : lecture/insertion strictement tenant et brouillon.
-- Aucun UPDATE ; DELETE
-- seulement pendant la vie du brouillon cible (le trigger SQL rend la preuve append-only dès
-- l'émission et refuse également toute suppression orpheline).
DROP POLICY IF EXISTS tenant_isolation ON invoice_predecessors;
DROP POLICY IF EXISTS invoice_predecessor_select ON invoice_predecessors;
DROP POLICY IF EXISTS invoice_predecessor_insert ON invoice_predecessors;
DROP POLICY IF EXISTS invoice_predecessor_delete_draft ON invoice_predecessors;
CREATE POLICY invoice_predecessor_select ON invoice_predecessors FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY invoice_predecessor_insert ON invoice_predecessors FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = invoice_predecessors."invoiceId"
         AND i."companyId" = invoice_predecessors."companyId"
         AND i.status = 'draft'
    )
  );
CREATE POLICY invoice_predecessor_delete_draft ON invoice_predecessors FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = invoice_predecessors."invoiceId"
         AND i."companyId" = invoice_predecessors."companyId"
         AND i.status = 'draft'
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON payments;
CREATE POLICY tenant_isolation ON payments
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON expenses;
CREATE POLICY tenant_isolation ON expenses
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON expense_creation_requests;
DROP POLICY IF EXISTS tenant_expense_creation_request_select ON expense_creation_requests;
DROP POLICY IF EXISTS tenant_expense_creation_request_insert ON expense_creation_requests;
CREATE POLICY tenant_expense_creation_request_select ON expense_creation_requests
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_expense_creation_request_insert ON expense_creation_requests
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON quote_creation_requests;
DROP POLICY IF EXISTS tenant_quote_creation_request_select ON quote_creation_requests;
DROP POLICY IF EXISTS tenant_quote_creation_request_insert ON quote_creation_requests;
CREATE POLICY tenant_quote_creation_request_select ON quote_creation_requests
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_quote_creation_request_insert ON quote_creation_requests
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON documents;
DROP POLICY IF EXISTS tenant_document_select ON documents;
DROP POLICY IF EXISTS tenant_document_insert ON documents;
DROP POLICY IF EXISTS tenant_document_update ON documents;
DROP POLICY IF EXISTS generated_invoice_pdf_attestation_select_fence ON documents;
CREATE POLICY tenant_document_select ON documents FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_document_insert ON documents FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_document_update ON documents FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
-- Après activation V2, un PDF de facture généré n'est visible que si son profil a été attesté
-- depuis ses octets et correspond au snapshot d'audience. AS RESTRICTIVE compose ce fence avec
-- le tenant policy ci-dessus (AND), il ne peut jamais élargir une lecture.
CREATE POLICY generated_invoice_pdf_attestation_select_fence ON documents
  AS RESTRICTIVE FOR SELECT
  USING (
    origin <> 'generated'::public."StoredDocumentOrigin"
    OR kind <> 'invoice_pdf'::public."StoredDocumentKind"
    OR NOT EXISTS (
      SELECT 1
        FROM public.document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 2
    )
    OR (
      "linkedEntityType" = 'invoice'::public."StoredDocumentLinkedEntityType"
      AND btrim(coalesce("linkedEntityId", '')) <> ''
      AND public.generated_invoice_pdf_attestation_visible_v2("companyId", id)
    )
  );
-- Pas de policy DELETE : la purge après rétention appartient à une capacité d'administration
-- distincte. Une dérive future d'ACL ne doit pas rendre le hard-delete accessible au runtime.

DROP POLICY IF EXISTS tenant_isolation ON document_analyses;
DROP POLICY IF EXISTS tenant_analysis_select ON document_analyses;
DROP POLICY IF EXISTS tenant_analysis_insert ON document_analyses;
CREATE POLICY tenant_analysis_select ON document_analyses
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_analysis_insert ON document_analyses
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON document_folders;
CREATE POLICY tenant_isolation ON document_folders
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON document_folder_deletion_plans;
CREATE POLICY tenant_isolation ON document_folder_deletion_plans
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_or_public_token_lookup ON public_access_tokens;
CREATE POLICY tenant_or_public_token_lookup ON public_access_tokens
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR "tokenHash" = current_setting('app.public_access_token_hash', true)
  )
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON document_counters;
CREATE POLICY tenant_isolation ON document_counters
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_admission_events;
CREATE POLICY tenant_isolation ON realtime_admission_events
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
DROP POLICY IF EXISTS realtime_admission_event_reaper_directory_select
  ON realtime_admission_events;
DROP POLICY IF EXISTS realtime_admission_event_reaper_schedule_select
  ON realtime_admission_events;

DROP POLICY IF EXISTS tenant_isolation ON realtime_admission_cancellation_fences;
DROP POLICY IF EXISTS realtime_admission_cancellation_fence_tenant_isolation
  ON realtime_admission_cancellation_fences;
CREATE POLICY tenant_isolation ON realtime_admission_cancellation_fences
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_session_leases;
CREATE POLICY tenant_isolation ON realtime_session_leases
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
DROP POLICY IF EXISTS realtime_session_lease_reaper_directory_select
  ON realtime_session_leases;
DROP POLICY IF EXISTS realtime_session_lease_reaper_schedule_select
  ON realtime_session_leases;

DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_ingress_tickets;
CREATE POLICY tenant_isolation ON realtime_mistral_ingress_tickets
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_bootstrap_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_select
  ON realtime_mistral_conversation_bootstrap_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_insert
  ON realtime_mistral_conversation_bootstrap_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_update
  ON realtime_mistral_conversation_bootstrap_tickets;
CREATE POLICY realtime_mistral_conversation_bootstrap_select
  ON realtime_mistral_conversation_bootstrap_tickets FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_bootstrap_insert
  ON realtime_mistral_conversation_bootstrap_tickets FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_bootstrap_update
  ON realtime_mistral_conversation_bootstrap_tickets FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Mission v2 mutable uniquement par CAS. L'absence volontaire de policy DELETE réserve la purge
-- post-rétention au reaper privilégié ; l'owner brut n'est jamais présent dans cette table.
DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_missions;
DROP POLICY IF EXISTS realtime_mistral_conversation_mission_select ON realtime_mistral_conversation_missions;
DROP POLICY IF EXISTS realtime_mistral_conversation_mission_insert ON realtime_mistral_conversation_missions;
DROP POLICY IF EXISTS realtime_mistral_conversation_mission_update ON realtime_mistral_conversation_missions;
CREATE POLICY realtime_mistral_conversation_mission_select
  ON realtime_mistral_conversation_missions FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_mission_insert
  ON realtime_mistral_conversation_missions FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_mission_update
  ON realtime_mistral_conversation_missions FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Reçu terminal append-only, sans payload utilisateur. Le tenant peut uniquement le relire ;
-- son écriture est réservée au propriétaire de la fonction trigger SECURITY DEFINER.
DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_terminal_receipts;
DROP POLICY IF EXISTS realtime_mistral_terminal_receipt_select
  ON realtime_mistral_conversation_terminal_receipts;
DROP POLICY IF EXISTS realtime_mistral_terminal_receipt_direct_insert
  ON realtime_mistral_conversation_terminal_receipts;
CREATE POLICY realtime_mistral_terminal_receipt_select
  ON realtime_mistral_conversation_terminal_receipts FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_terminal_receipt_direct_insert
  ON realtime_mistral_conversation_terminal_receipts FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_resume_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_resume_ticket_select
  ON realtime_mistral_conversation_resume_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_resume_ticket_insert
  ON realtime_mistral_conversation_resume_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_resume_ticket_update
  ON realtime_mistral_conversation_resume_tickets;
CREATE POLICY realtime_mistral_conversation_resume_ticket_select
  ON realtime_mistral_conversation_resume_tickets FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_resume_ticket_insert
  ON realtime_mistral_conversation_resume_tickets FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_resume_ticket_update
  ON realtime_mistral_conversation_resume_tickets FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Outbox et ledger sont append-only. Le runtime peut rejouer/lire et insérer dans la transaction
-- autoritaire, mais aucune policy UPDATE/DELETE ne peut rendre l'historique réécrivable.
DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_outbox;
DROP POLICY IF EXISTS realtime_mistral_conversation_outbox_select ON realtime_mistral_conversation_outbox;
DROP POLICY IF EXISTS realtime_mistral_conversation_outbox_insert ON realtime_mistral_conversation_outbox;
CREATE POLICY realtime_mistral_conversation_outbox_select
  ON realtime_mistral_conversation_outbox FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_outbox_insert
  ON realtime_mistral_conversation_outbox FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_conversation_commands;
DROP POLICY IF EXISTS realtime_mistral_conversation_command_select ON realtime_mistral_conversation_commands;
DROP POLICY IF EXISTS realtime_mistral_conversation_command_insert ON realtime_mistral_conversation_commands;
CREATE POLICY realtime_mistral_conversation_command_select
  ON realtime_mistral_conversation_commands FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_command_insert
  ON realtime_mistral_conversation_commands FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Autorité globale de rétention Mistral v2. Le rôle NOLOGIN n'obtient aucun contexte tenant :
-- il ne voit que les groupes arrivés après grâce + rétention. SELECT/lock voit volontairement
-- tous les enfants d'une Mission éligible afin qu'une rétention enfant plus longue bloque la
-- purge atomique ; DELETE reste strictement limité aux enfants eux-mêmes expirés.
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_reaper_select
  ON realtime_mistral_conversation_bootstrap_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_reaper_lock
  ON realtime_mistral_conversation_bootstrap_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_bootstrap_reaper_delete
  ON realtime_mistral_conversation_bootstrap_tickets;
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_select
  ON realtime_mistral_conversation_bootstrap_tickets FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  );
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_lock
  ON realtime_mistral_conversation_bootstrap_tickets FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_delete
  ON realtime_mistral_conversation_bootstrap_tickets FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  );

DROP POLICY IF EXISTS realtime_mistral_conversation_mission_reaper_select
  ON realtime_mistral_conversation_missions;
DROP POLICY IF EXISTS realtime_mistral_conversation_mission_reaper_lock
  ON realtime_mistral_conversation_missions;
DROP POLICY IF EXISTS realtime_mistral_conversation_mission_reaper_delete
  ON realtime_mistral_conversation_missions;
CREATE POLICY realtime_mistral_conversation_mission_reaper_select
  ON realtime_mistral_conversation_missions FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  );
CREATE POLICY realtime_mistral_conversation_mission_reaper_lock
  ON realtime_mistral_conversation_missions FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND phase = 'closed'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_mission_reaper_delete
  ON realtime_mistral_conversation_missions FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND phase = 'closed'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  );

DROP POLICY IF EXISTS realtime_mistral_terminal_receipt_reaper_select
  ON realtime_mistral_conversation_terminal_receipts;
CREATE POLICY realtime_mistral_terminal_receipt_reaper_select
  ON realtime_mistral_conversation_terminal_receipts FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission."companyId" =
             realtime_mistral_conversation_terminal_receipts."companyId"
         AND mission."sessionHandle" =
             realtime_mistral_conversation_terminal_receipts."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

DROP POLICY IF EXISTS realtime_mistral_conversation_resume_reaper_select
  ON realtime_mistral_conversation_resume_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_resume_reaper_lock
  ON realtime_mistral_conversation_resume_tickets;
DROP POLICY IF EXISTS realtime_mistral_conversation_resume_reaper_delete
  ON realtime_mistral_conversation_resume_tickets;
CREATE POLICY realtime_mistral_conversation_resume_reaper_select
  ON realtime_mistral_conversation_resume_tickets FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
CREATE POLICY realtime_mistral_conversation_resume_reaper_lock
  ON realtime_mistral_conversation_resume_tickets FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_resume_reaper_delete
  ON realtime_mistral_conversation_resume_tickets FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_resume_tickets."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

DROP POLICY IF EXISTS realtime_mistral_conversation_outbox_reaper_select
  ON realtime_mistral_conversation_outbox;
DROP POLICY IF EXISTS realtime_mistral_conversation_outbox_reaper_delete
  ON realtime_mistral_conversation_outbox;
CREATE POLICY realtime_mistral_conversation_outbox_reaper_select
  ON realtime_mistral_conversation_outbox FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_outbox."missionId"
         AND mission."companyId" = realtime_mistral_conversation_outbox."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_outbox."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
CREATE POLICY realtime_mistral_conversation_outbox_reaper_delete
  ON realtime_mistral_conversation_outbox FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_outbox."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_outbox."missionId"
         AND mission."companyId" = realtime_mistral_conversation_outbox."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_outbox."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

DROP POLICY IF EXISTS realtime_mistral_conversation_command_reaper_select
  ON realtime_mistral_conversation_commands;
DROP POLICY IF EXISTS realtime_mistral_conversation_command_reaper_delete
  ON realtime_mistral_conversation_commands;
CREATE POLICY realtime_mistral_conversation_command_reaper_select
  ON realtime_mistral_conversation_commands FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_commands."missionId"
         AND mission."companyId" = realtime_mistral_conversation_commands."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_commands."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
CREATE POLICY realtime_mistral_conversation_command_reaper_delete
  ON realtime_mistral_conversation_commands FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_commands."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_commands."missionId"
         AND mission."companyId" = realtime_mistral_conversation_commands."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_commands."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

DROP POLICY IF EXISTS realtime_session_lease_mistral_retention_reaper_select
  ON realtime_session_leases;
CREATE POLICY realtime_session_lease_mistral_retention_reaper_select
  ON realtime_session_leases FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
        JOIN public.realtime_mistral_conversation_missions AS mission
          ON mission."companyId" = bootstrap."companyId"
         AND mission."initialBootstrapId" = bootstrap.id
       WHERE bootstrap."admissionSessionId" = realtime_session_leases."sessionId"
         AND bootstrap."companyId" = realtime_session_leases."companyId"
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

-- Registres globaux sans secret ni donnée tenant, isolés par keySpace (persistance et HMAC sujet).
-- Le runtime peut seulement lire ; DIRECT_URL prépare/retire pendant le protocole CD en deux phases.
DROP POLICY IF EXISTS realtime_mistral_conversation_key_version_floor_select
  ON realtime_mistral_conversation_key_version_floors;
CREATE POLICY realtime_mistral_conversation_key_version_floor_select
  ON realtime_mistral_conversation_key_version_floors FOR SELECT
  USING (true);
DROP POLICY IF EXISTS realtime_mistral_conversation_key_version_floor_direct_insert
  ON realtime_mistral_conversation_key_version_floors;
CREATE POLICY realtime_mistral_conversation_key_version_floor_direct_insert
  ON realtime_mistral_conversation_key_version_floors FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);
DROP POLICY IF EXISTS realtime_mistral_conversation_key_version_floor_direct_update
  ON realtime_mistral_conversation_key_version_floors;
CREATE POLICY realtime_mistral_conversation_key_version_floor_direct_update
  ON realtime_mistral_conversation_key_version_floors FOR UPDATE
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS realtime_mistral_conversation_key_binding_select
  ON realtime_mistral_conversation_key_bindings;
CREATE POLICY realtime_mistral_conversation_key_binding_select
  ON realtime_mistral_conversation_key_bindings FOR SELECT
  USING (true);
DROP POLICY IF EXISTS realtime_mistral_conversation_key_binding_direct_insert
  ON realtime_mistral_conversation_key_bindings;
CREATE POLICY realtime_mistral_conversation_key_binding_direct_insert
  ON realtime_mistral_conversation_key_bindings FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);

-- Le key-space AEAD identité est indépendant mais possède la même frontière de privilèges :
-- lecture globale sans secret pour le runtime, stage/retire exclusivement via DIRECT_URL.
DROP POLICY IF EXISTS realtime_mistral_identity_key_floor_select
  ON realtime_mistral_conversation_identity_key_version_floors;
CREATE POLICY realtime_mistral_identity_key_floor_select
  ON realtime_mistral_conversation_identity_key_version_floors FOR SELECT
  USING (true);
DROP POLICY IF EXISTS realtime_mistral_identity_key_floor_direct_insert
  ON realtime_mistral_conversation_identity_key_version_floors;
CREATE POLICY realtime_mistral_identity_key_floor_direct_insert
  ON realtime_mistral_conversation_identity_key_version_floors FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);
DROP POLICY IF EXISTS realtime_mistral_identity_key_floor_direct_update
  ON realtime_mistral_conversation_identity_key_version_floors;
CREATE POLICY realtime_mistral_identity_key_floor_direct_update
  ON realtime_mistral_conversation_identity_key_version_floors FOR UPDATE
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS realtime_mistral_identity_key_binding_select
  ON realtime_mistral_conversation_identity_key_bindings;
CREATE POLICY realtime_mistral_identity_key_binding_select
  ON realtime_mistral_conversation_identity_key_bindings FOR SELECT
  USING (true);
DROP POLICY IF EXISTS realtime_mistral_identity_key_binding_direct_insert
  ON realtime_mistral_conversation_identity_key_bindings;
CREATE POLICY realtime_mistral_identity_key_binding_direct_insert
  ON realtime_mistral_conversation_identity_key_bindings FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_isolation ON realtime_speech_artifacts;
DROP POLICY IF EXISTS realtime_speech_artifact_select ON realtime_speech_artifacts;
DROP POLICY IF EXISTS realtime_speech_artifact_insert ON realtime_speech_artifacts;
DROP POLICY IF EXISTS realtime_speech_artifact_update ON realtime_speech_artifacts;
CREATE POLICY realtime_speech_artifact_select ON realtime_speech_artifacts
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_speech_artifact_insert ON realtime_speech_artifacts
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_speech_artifact_update ON realtime_speech_artifacts
  FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Annuaire provider-neutral du reaper admission. Le rôle propriétaire NOLOGIN est provisionné et
-- ses ACL sont normalisées par release.sh après chaque replay RLS.
-- Les fonctions appartiennent après la première release au rôle NOLOGIN directory. Leur ACL ne
-- peut donc être normalisée ici par un DIRECT_URL BYPASSRLS non-superuser/non-INHERIT. Le
-- provisionnement owner-scoped qui suit immédiatement ce replay les révoque et les certifie.
REVOKE ALL ON TABLE public.realtime_reaper_tenant_schedule FROM PUBLIC;
REVOKE ALL ON TABLE public.realtime_reaper_directory_cursor FROM PUBLIC;
ALTER TABLE public.realtime_reaper_tenant_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_reaper_tenant_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_reaper_directory_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_reaper_directory_cursor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realtime_reaper_tenant_schedule_authority
  ON public.realtime_reaper_tenant_schedule;
DROP POLICY IF EXISTS realtime_reaper_tenant_schedule_tenant_select
  ON public.realtime_reaper_tenant_schedule;
DROP POLICY IF EXISTS realtime_reaper_tenant_schedule_tenant_insert
  ON public.realtime_reaper_tenant_schedule;
DROP POLICY IF EXISTS realtime_reaper_tenant_schedule_tenant_update
  ON public.realtime_reaper_tenant_schedule;
DROP POLICY IF EXISTS realtime_reaper_tenant_schedule_tenant_delete
  ON public.realtime_reaper_tenant_schedule;
CREATE POLICY realtime_reaper_tenant_schedule_authority
  ON public.realtime_reaper_tenant_schedule FOR ALL
  USING (
    current_user = 'bob_realtime_reaper_directory'
    OR current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass
    ))
  )
  WITH CHECK (
    current_user = 'bob_realtime_reaper_directory'
    OR current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass
    ))
  );
CREATE POLICY realtime_reaper_tenant_schedule_tenant_select
  ON public.realtime_reaper_tenant_schedule FOR SELECT
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', TRUE), ''));
CREATE POLICY realtime_reaper_tenant_schedule_tenant_insert
  ON public.realtime_reaper_tenant_schedule FOR INSERT
  WITH CHECK ("companyId" = NULLIF(current_setting('app.current_company_id', TRUE), ''));
CREATE POLICY realtime_reaper_tenant_schedule_tenant_update
  ON public.realtime_reaper_tenant_schedule FOR UPDATE
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', TRUE), ''))
  WITH CHECK ("companyId" = NULLIF(current_setting('app.current_company_id', TRUE), ''));
CREATE POLICY realtime_reaper_tenant_schedule_tenant_delete
  ON public.realtime_reaper_tenant_schedule FOR DELETE
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', TRUE), ''));
DROP POLICY IF EXISTS realtime_reaper_directory_cursor_select
  ON public.realtime_reaper_directory_cursor;
DROP POLICY IF EXISTS realtime_reaper_directory_cursor_update
  ON public.realtime_reaper_directory_cursor;
CREATE POLICY realtime_reaper_directory_cursor_select
  ON public.realtime_reaper_directory_cursor FOR SELECT
  USING (current_user = 'bob_realtime_reaper_directory');
CREATE POLICY realtime_reaper_directory_cursor_update
  ON public.realtime_reaper_directory_cursor FOR UPDATE
  USING (current_user = 'bob_realtime_reaper_directory')
  WITH CHECK (current_user = 'bob_realtime_reaper_directory');
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_reaper_tenant_schedule FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_reaper_directory_cursor FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

-- Preuve OpenAI RTP native : CAS tenanté et DELETE de rétention doublement borné. Le seul helper
-- global exposable ne renvoie que les identifiants des tenants ayant du travail déjà dû.
REVOKE ALL ON FUNCTION public.assert_realtime_native_delivery_fence_v1(
  TEXT, CHAR(64), UUID, TEXT, INTEGER, CHAR(64), CHAR(64), INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retained_openai_native_proof_hmac_key_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_native_speech_slo_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_delete_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_realtime_native_delivery_truncate_v1() FROM PUBLIC;
-- À la première release, le déployeur possède encore ces fonctions. Aux replays suivants,
-- elles appartiennent déjà à l'autorité NOLOGIN. Supabase refuse alors toute modification ACL
-- exécutée directement par le déployeur : normaliser exclusivement sous l'owner exact.
DO $directory_function_owner$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid IN (
       'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
       'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
       'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
     )
       AND function.proowner <> (
         SELECT role.oid
           FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = session_user
       )
       AND NOT pg_catalog.pg_has_role(session_user, function.proowner, 'SET')
  ) THEN
    RAISE EXCEPTION
      'OpenAI native maintenance directory function has an unexpected owner during RLS replay';
  END IF;
END;
$directory_function_owner$;
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::regprocedure,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid IN (
   'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
   'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
   'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
 )
\gexec
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; SET LOCAL ROLE %I;',
  owner.rolname,
  function.oid::regprocedure,
  exposed_role.rolname,
  current_setting('bob.release.rls_owner_role')
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid IN (
   'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)'::regprocedure,
   'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)'::regprocedure,
   'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)'::regprocedure
 )
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

REVOKE ALL ON TABLE public.realtime_native_speech_maintenance_cursors FROM PUBLIC;
ALTER TABLE public.realtime_native_speech_maintenance_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_native_speech_maintenance_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realtime_native_speech_maintenance_cursor_directory_select
  ON public.realtime_native_speech_maintenance_cursors;
DROP POLICY IF EXISTS realtime_native_speech_maintenance_cursor_directory_update
  ON public.realtime_native_speech_maintenance_cursors;
CREATE POLICY realtime_native_speech_maintenance_cursor_directory_select
  ON public.realtime_native_speech_maintenance_cursors
  FOR SELECT
  USING (current_user = 'bob_openai_native_maintenance_directory');
CREATE POLICY realtime_native_speech_maintenance_cursor_directory_update
  ON public.realtime_native_speech_maintenance_cursors
  FOR UPDATE
  USING (current_user = 'bob_openai_native_maintenance_directory')
  WITH CHECK (current_user = 'bob_openai_native_maintenance_directory');
-- L'ACL de l'annuaire global est normalisée par provision_openai_native_maintenance_directory,
-- sous son owner NOLOGIN exact, immédiatement après ce replay RLS dans release.sh.
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_native_delivery_delete_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.deny_realtime_native_delivery_truncate_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_native_speech_maintenance_cursors FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_realtime_control_grant_binding_v3(
  TEXT, INTEGER, UUID, UUID, TEXT, UUID, UUID, INTEGER, CHAR(64),
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_realtime_control_consumption_binding_v3(
  TEXT, UUID, UUID, UUID, UUID, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_control_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_control_grant_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_control_consumption() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_control_consumption_v2() FROM PUBLIC;

DROP POLICY IF EXISTS tenant_isolation ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_select ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_insert ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_update ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_due_directory_select ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_delete_tenant ON realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_delete_retention_fence ON realtime_native_speech_deliveries;
CREATE POLICY realtime_native_speech_delivery_select ON realtime_native_speech_deliveries
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_insert ON realtime_native_speech_deliveries
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_update ON realtime_native_speech_deliveries
  FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_due_directory_select
  ON realtime_native_speech_deliveries
  FOR SELECT
  USING (
    current_user = 'bob_openai_native_maintenance_directory'
    AND (
      (
        phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
        AND "expiresAt" <= statement_timestamp()
      )
      OR (
        phase IN ('delivered', 'cancelled', 'failed', 'expired')
        AND "retentionExpiresAt" <= statement_timestamp()
      )
    )
  );
CREATE POLICY realtime_native_speech_delivery_delete_tenant ON realtime_native_speech_deliveries
  FOR DELETE
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_delete_retention_fence
  ON realtime_native_speech_deliveries
  AS RESTRICTIVE
  FOR DELETE
  USING (
    phase IN ('delivered', 'cancelled', 'failed', 'expired')
    AND "retentionExpiresAt" <= statement_timestamp()
    AND NOT EXISTS (
      SELECT 1
        FROM realtime_control_grants AS control_grant
       WHERE control_grant."companyId" = realtime_native_speech_deliveries."companyId"
         AND control_grant."nativeDeliveryId" = realtime_native_speech_deliveries."deliveryId"
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON realtime_control_grants;
DROP POLICY IF EXISTS realtime_control_grant_select ON realtime_control_grants;
DROP POLICY IF EXISTS realtime_control_grant_insert ON realtime_control_grants;
CREATE POLICY realtime_control_grant_select ON realtime_control_grants
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_control_grant_insert ON realtime_control_grants
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_control_consumptions;
DROP POLICY IF EXISTS realtime_control_consumption_select ON realtime_control_consumptions;
DROP POLICY IF EXISTS realtime_control_consumption_insert ON realtime_control_consumptions;
CREATE POLICY realtime_control_consumption_select ON realtime_control_consumptions
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_control_consumption_insert ON realtime_control_consumptions
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_voice_usage_events;
DROP POLICY IF EXISTS realtime_voice_usage_event_select ON realtime_voice_usage_events;
DROP POLICY IF EXISTS realtime_voice_usage_event_insert ON realtime_voice_usage_events;
CREATE POLICY realtime_voice_usage_event_select ON realtime_voice_usage_events
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_voice_usage_event_insert ON realtime_voice_usage_events
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_voice_usage_daily;
DROP POLICY IF EXISTS realtime_voice_usage_daily_select ON realtime_voice_usage_daily;
DROP POLICY IF EXISTS realtime_voice_usage_daily_rollup_insert ON realtime_voice_usage_daily;
DROP POLICY IF EXISTS realtime_voice_usage_daily_rollup_update ON realtime_voice_usage_daily;
CREATE POLICY realtime_voice_usage_daily_select ON realtime_voice_usage_daily
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_voice_usage_daily_rollup_insert ON realtime_voice_usage_daily
  FOR INSERT WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  );
CREATE POLICY realtime_voice_usage_daily_rollup_update ON realtime_voice_usage_daily
  FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  );

DROP POLICY IF EXISTS tenant_isolation ON document_archive_jobs;
DROP POLICY IF EXISTS document_archive_jobs_tenant_select ON document_archive_jobs;
DROP POLICY IF EXISTS document_archive_jobs_tenant_insert ON document_archive_jobs;
DROP POLICY IF EXISTS document_archive_jobs_tenant_update ON document_archive_jobs;
CREATE POLICY document_archive_jobs_tenant_select ON document_archive_jobs
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
-- Fenêtre expand N/N-1 : l'ancien binaire écrit encore directement dans l'outbox. Ces policies
-- sont donc doublement bornées par le tenant ET par le rail monotone V1. L'activation V2 change
-- l'état dans la même transaction que le retrait des ACL : même si un GRANT dérivait plus tard,
-- les policies resteraient fermées. Le writer N utilise déjà les capacités SECURITY DEFINER V2.
CREATE POLICY document_archive_jobs_tenant_insert ON document_archive_jobs FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND EXISTS (
      SELECT 1
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 1
    )
  );
CREATE POLICY document_archive_jobs_tenant_update ON document_archive_jobs FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND EXISTS (
      SELECT 1
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 1
    )
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND EXISTS (
      SELECT 1
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 1
    )
  );
-- Jamais de policy DELETE. Après activation V2, aucune policy INSERT/UPDATE n'est satisfiable et
-- le runtime ne conserve que enqueue/claim/fail/complete, qui bornent identité, horloge et preuve.

DROP POLICY IF EXISTS document_archive_job_artifacts_tenant_select
  ON document_archive_job_artifacts;
CREATE POLICY document_archive_job_artifacts_tenant_select ON document_archive_job_artifacts
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS document_archive_render_snapshots_tenant_select
  ON document_archive_render_snapshots;
CREATE POLICY document_archive_render_snapshots_tenant_select
  ON document_archive_render_snapshots FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
-- Intentions et singleton de cutover : aucune policy runtime. Leur lecture/écriture passe
-- exclusivement par les capacités SECURITY DEFINER tenant-scopées et les opérateurs DIRECT_URL.

DROP POLICY IF EXISTS document_invoice_pdf_attestations_tenant_select
  ON document_invoice_pdf_attestations;
CREATE POLICY document_invoice_pdf_attestations_tenant_select
  ON document_invoice_pdf_attestations FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON notification_jobs;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  ) THEN
    -- Phase expand : N-1 garde ses lectures/écritures métier, mais le trigger force tout job
    -- à l'an 9999. Aucune livraison ne peut partir pendant le rolling deploy.
    EXECUTE $policy$
      CREATE POLICY tenant_isolation ON notification_jobs
        USING ("companyId" = current_setting('app.current_company_id', true))
        WITH CHECK ("companyId" = current_setting('app.current_company_id', true))
    $policy$;
  ELSE
    -- Phase active : une révision N-1 qui ignore leases/idempotence ne voit plus l'outbox.
    EXECUTE $policy$
      CREATE POLICY tenant_isolation ON notification_jobs
        USING (
          "companyId" = current_setting('app.current_company_id', true)
          AND current_setting('app.notification_outbox_version', true) = '2'
        )
        WITH CHECK (
          "companyId" = current_setting('app.current_company_id', true)
          AND current_setting('app.notification_outbox_version', true) = '2'
        )
    $policy$;
  END IF;
END;
$$;

-- Le token push est une capacité à forte entropie remise par l'OS. Pendant le seul statement
-- d'enregistrement, elle permet de voir puis transférer SON ancienne ligne cross-tenant. La
-- contrainte UNIQUE globale sérialise deux rebinds concurrents. Toutes les autres opérations
-- restent strictement company-scoped ; le repository efface le GUC juste après le statement.
DROP POLICY IF EXISTS tenant_isolation ON devices;
DROP POLICY IF EXISTS device_tenant_select ON devices;
DROP POLICY IF EXISTS device_token_rebind_select ON devices;
DROP POLICY IF EXISTS device_legacy_token_rebind_select ON devices;
DROP POLICY IF EXISTS device_provider_revoke_lookup_select ON devices;
DROP POLICY IF EXISTS device_installation_capability_select ON devices;
DROP POLICY IF EXISTS device_binding_capability_select ON devices;
DROP POLICY IF EXISTS device_tenant_insert ON devices;
DROP POLICY IF EXISTS device_v2_register_insert ON devices;
DROP POLICY IF EXISTS device_tenant_update ON devices;
DROP POLICY IF EXISTS device_token_rebind_update ON devices;
DROP POLICY IF EXISTS device_legacy_token_rebind_update ON devices;
DROP POLICY IF EXISTS device_tenant_delete ON devices;
DROP POLICY IF EXISTS device_installation_rebind_delete ON devices;
DROP POLICY IF EXISTS device_binding_revoke_delete ON devices;
DROP POLICY IF EXISTS device_token_transfer_delete ON devices;
DROP POLICY IF EXISTS device_close_account_delete ON devices;

CREATE POLICY device_tenant_select ON devices FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND current_setting('app.current_device_operation', true) IN (
      'deliver', 'close-account', 'legacy-owner-revoke'
    )
  );
CREATE POLICY device_provider_revoke_lookup_select ON devices FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'provider-revoke-lookup'
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "bindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
    AND "bindingGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
    AND "installationId" IS NOT NULL
    AND "revocationSecretHash" IS NOT NULL
  );
CREATE POLICY device_token_rebind_select ON devices FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND
    "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
  );
-- Fenêtre de cutover N-1 : l'ancien serveur pose uniquement le token capability. Il peut encore
-- déplacer une ligne LEGACY, mais son worker listByCompany (sans token GUC) voit zéro ligne et ne
-- peut donc jamais envoyer un push sans fence v2.
CREATE POLICY device_legacy_token_rebind_select ON devices FOR SELECT
  USING (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  );
-- UPDATE/DELETE sous FORCE RLS nécessitent aussi une visibilité SELECT de la ligne ciblée.
-- Ces capacités sont opaques, exactes et transaction-locales ; elles n'élargissent jamais une
-- liste tenant générique.
CREATE POLICY device_installation_capability_select ON devices FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) IN ('register', 'revoke-auth', 'revoke-public')
    AND "installationId" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  );
CREATE POLICY device_binding_capability_select ON devices FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND "bindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
  );
CREATE POLICY device_tenant_insert ON devices FOR INSERT
  WITH CHECK (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  );
CREATE POLICY device_v2_register_insert ON devices FOR INSERT
  WITH CHECK (
    current_setting('app.current_device_operation', true) = 'register'
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "userId" IS NOT DISTINCT FROM nullif(current_setting('app.current_device_user_id', true), '')
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "installationId" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "bindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
    AND "bindingGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
    AND "bindingGeneration" > 0
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  );
CREATE POLICY device_tenant_update ON devices FOR UPDATE
  USING (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  )
  WITH CHECK (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  );
CREATE POLICY device_token_rebind_update ON devices FOR UPDATE
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND
    "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
  )
  WITH CHECK (
    current_setting('app.current_device_operation', true) = 'register'
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "userId" IS NOT DISTINCT FROM nullif(current_setting('app.current_device_user_id', true), '')
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "installationId" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "bindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
    AND "bindingGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
    AND "bindingGeneration" > 0
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  );
CREATE POLICY device_legacy_token_rebind_update ON devices FOR UPDATE
  USING (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  )
  WITH CHECK (
    coalesce(current_setting('app.current_device_operation', true), '') = ''
    AND "companyId" = current_setting('app.current_company_id', true)
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  );
CREATE POLICY device_tenant_delete ON devices FOR DELETE
  USING (
    current_setting('app.current_device_operation', true) = 'legacy-owner-revoke'
    AND
    "companyId" = current_setting('app.current_company_id', true)
    AND "userId" IS NOT DISTINCT FROM nullif(current_setting('app.current_device_user_id', true), '')
    AND "installationId" IS NULL
    AND "bindingId" IS NULL
    AND "bindingGeneration" IS NULL
    AND "revocationSecretHash" IS NULL
  );
CREATE POLICY device_installation_rebind_delete ON devices FOR DELETE
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND "installationId" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  );
CREATE POLICY device_binding_revoke_delete ON devices FOR DELETE
  USING (
    current_setting('app.current_device_operation', true) IN ('revoke-auth', 'revoke-public')
    AND
    "installationId" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "bindingGeneration" <= nullif(current_setting('app.current_device_binding_generation', true), '')::integer
  );
CREATE POLICY device_token_transfer_delete ON devices FOR DELETE
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND "expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
  );
CREATE POLICY device_close_account_delete ON devices FOR DELETE
  USING (
    current_setting('app.current_device_operation', true) = 'close-account'
    AND "companyId" = current_setting('app.current_company_id', true)
  );

-- Registre global sans donnée métier : il conserve uniquement le high-water mark d'une
-- installation. Le secret 256-bit (hashé) + le mode explicite bornent chaque opération ; aucune
-- policy tenant générique ne doit être ajoutée à cette table.
DROP POLICY IF EXISTS push_installation_capability_select ON push_installations;
DROP POLICY IF EXISTS push_installation_token_transfer_select ON push_installations;
DROP POLICY IF EXISTS push_installation_binding_capability_select ON push_installations;
DROP POLICY IF EXISTS push_installation_delivery_select ON push_installations;
DROP POLICY IF EXISTS push_installation_register_insert ON push_installations;
DROP POLICY IF EXISTS push_installation_register_update ON push_installations;
DROP POLICY IF EXISTS push_installation_revoke_update ON push_installations;
DROP POLICY IF EXISTS push_installation_token_transfer_update ON push_installations;
DROP POLICY IF EXISTS push_installation_close_account_select ON push_installations;
DROP POLICY IF EXISTS push_installation_close_account_update ON push_installations;

CREATE POLICY push_installation_capability_select ON push_installations FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) IN ('register', 'revoke-auth', 'revoke-public', 'close-account')
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  );
CREATE POLICY push_installation_token_transfer_select ON push_installations FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND EXISTS (
      SELECT 1
      FROM devices AS bound_device
      WHERE bound_device."installationId" = push_installations."id"
        AND bound_device."expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    )
  );
CREATE POLICY push_installation_binding_capability_select ON push_installations FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND "currentBindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
  );
CREATE POLICY push_installation_delivery_select ON push_installations FOR SELECT
  USING (
    current_setting('app.current_device_operation', true) = 'deliver'
    AND "currentCompanyId" = current_setting('app.current_company_id', true)
  );
CREATE POLICY push_installation_register_insert ON push_installations FOR INSERT
  WITH CHECK (
    current_setting('app.current_device_operation', true) IN ('register', 'revoke-auth')
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND (
      (
        current_setting('app.current_device_operation', true) = 'register'
        AND "currentCompanyId" = current_setting('app.current_company_id', true)
        AND "currentUserId" IS NOT DISTINCT FROM nullif(current_setting('app.current_device_user_id', true), '')
        AND "currentBindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
        AND "maxGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
        AND "maxGeneration" > 0
      )
      OR (
        current_setting('app.current_device_operation', true) = 'revoke-auth'
        AND "maxGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
        AND "maxGeneration" > 0
        AND "currentCompanyId" IS NULL
        AND "currentUserId" IS NULL
        AND "currentBindingId" IS NULL
        AND "lastConfirmedAt" IS NULL
      )
    )
  );
CREATE POLICY push_installation_register_update ON push_installations FOR UPDATE
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
  )
  WITH CHECK (
    current_setting('app.current_device_operation', true) = 'register'
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "currentCompanyId" = current_setting('app.current_company_id', true)
    AND "currentUserId" IS NOT DISTINCT FROM nullif(current_setting('app.current_device_user_id', true), '')
    AND "currentBindingId" = nullif(current_setting('app.current_device_binding_id', true), '')::uuid
    AND "maxGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
    AND "maxGeneration" > 0
  );
CREATE POLICY push_installation_revoke_update ON push_installations FOR UPDATE
  USING (
    current_setting('app.current_device_operation', true) IN ('revoke-auth', 'revoke-public')
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "maxGeneration" <= nullif(current_setting('app.current_device_binding_generation', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.current_device_operation', true) IN ('revoke-auth', 'revoke-public')
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "currentCompanyId" IS NULL
    AND "currentUserId" IS NULL
    AND "currentBindingId" IS NULL
    AND "maxGeneration" = nullif(current_setting('app.current_device_binding_generation', true), '')::integer
    AND "maxGeneration" > 0
  );
CREATE POLICY push_installation_token_transfer_update ON push_installations FOR UPDATE
  USING (
    current_setting('app.current_device_operation', true) = 'register'
    AND EXISTS (
      SELECT 1
      FROM devices AS bound_device
      WHERE bound_device."installationId" = push_installations."id"
        AND bound_device."expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.current_device_operation', true) = 'register'
    AND EXISTS (
      SELECT 1
      FROM devices AS bound_device
      WHERE bound_device."installationId" = push_installations."id"
        AND bound_device."expoPushToken" = nullif(current_setting('app.current_device_push_token', true), '')
    )
    AND "currentCompanyId" IS NULL
    AND "currentUserId" IS NULL
    AND "currentBindingId" IS NULL
  );
CREATE POLICY push_installation_close_account_update ON push_installations FOR UPDATE
  USING (
    current_setting('app.current_device_operation', true) = 'close-account'
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "currentCompanyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.current_device_operation', true) = 'close-account'
    AND "id" = nullif(current_setting('app.current_device_installation_id', true), '')::uuid
    AND "revocationSecretHash" = nullif(current_setting('app.current_device_revocation_hash', true), '')
    AND "currentCompanyId" IS NULL
    AND "currentUserId" IS NULL
    AND "currentBindingId" IS NULL
  );

DROP POLICY IF EXISTS tenant_isolation ON agent_journal_entries;
CREATE POLICY tenant_isolation ON agent_journal_entries
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Traces de comportement vocal (bêta-test). Le tour s'écrit en DEUX temps (transcription puis
-- planification/synthèse) : l'UPDATE est donc nécessaire, contrairement aux journaux append-only
-- voisins. Le DELETE l'est aussi — c'est la purge de rétention 30 jours, exécutée par tenant
-- sous le MÊME rôle applicatif (VoiceTracePurgeService) : sans policy DELETE, la rétention
-- resterait une colonne décorative et le stock de transcripts en clair serait permanent.
DROP POLICY IF EXISTS tenant_isolation ON voice_traces;
CREATE POLICY tenant_isolation ON voice_traces
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- Voice Trace Realtime V2 : le runtime écrit et ne relit que le digest de son propre sujet.
-- Maintenance, readiness et lecteur sont trois owners NOLOGIN séparés ; aucune policy DELETE
-- n'est accordée au rôle applicatif et aucune lecture opérateur n'évite l'audit atomique.
DROP POLICY IF EXISTS realtime_voice_trace_owner_all ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_subject_select ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_subject_insert ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_subject_delete ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_reader_select ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_readiness_select ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_maintenance_select ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_maintenance_lock ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_eraser_delete ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_reaper_delete ON realtime_voice_trace_events;
DROP POLICY IF EXISTS realtime_voice_trace_maintenance_delete ON realtime_voice_trace_events;
CREATE POLICY realtime_voice_trace_owner_all ON realtime_voice_trace_events FOR ALL
  USING (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_events'::regclass
    ))
  )
  WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_events'::regclass
    ))
  );
CREATE POLICY realtime_voice_trace_subject_select ON realtime_voice_trace_events
  FOR SELECT USING (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
    AND "userId" = NULLIF(current_setting('app.current_user_id', TRUE), '')::uuid
  );
CREATE POLICY realtime_voice_trace_subject_insert ON realtime_voice_trace_events
  FOR INSERT WITH CHECK (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
    AND "userId" = NULLIF(current_setting('app.current_user_id', TRUE), '')::uuid
  );
CREATE POLICY realtime_voice_trace_reader_select ON realtime_voice_trace_events
  FOR SELECT USING (current_user = 'bob_realtime_voice_trace_reader');
CREATE POLICY realtime_voice_trace_readiness_select ON realtime_voice_trace_events
  FOR SELECT USING (current_user = 'bob_realtime_voice_trace_key_readiness');
CREATE POLICY realtime_voice_trace_maintenance_select ON realtime_voice_trace_events
  FOR SELECT USING (current_user = 'bob_realtime_voice_trace_maintenance');
CREATE POLICY realtime_voice_trace_maintenance_lock ON realtime_voice_trace_events
  FOR UPDATE USING (current_user = 'bob_realtime_voice_trace_maintenance')
  WITH CHECK (FALSE);
CREATE POLICY realtime_voice_trace_maintenance_delete ON realtime_voice_trace_events
  FOR DELETE USING (current_user = 'bob_realtime_voice_trace_maintenance');

DROP POLICY IF EXISTS realtime_voice_trace_access_owner_all
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_reader_insert
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_readiness_select
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_maintenance_select
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_maintenance_lock
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_eraser_delete
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_reaper_delete
  ON realtime_voice_trace_access_audits;
DROP POLICY IF EXISTS realtime_voice_trace_access_maintenance_delete
  ON realtime_voice_trace_access_audits;
CREATE POLICY realtime_voice_trace_access_owner_all
  ON realtime_voice_trace_access_audits FOR ALL
  USING (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_access_audits'::regclass
    ))
  )
  WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_voice_trace_access_audits'::regclass
    ))
  );
CREATE POLICY realtime_voice_trace_access_reader_insert
  ON realtime_voice_trace_access_audits FOR INSERT
  WITH CHECK (current_user = 'bob_realtime_voice_trace_reader');
CREATE POLICY realtime_voice_trace_access_maintenance_select
  ON realtime_voice_trace_access_audits FOR SELECT
  USING (current_user = 'bob_realtime_voice_trace_maintenance');
CREATE POLICY realtime_voice_trace_access_maintenance_lock
  ON realtime_voice_trace_access_audits FOR UPDATE
  USING (current_user = 'bob_realtime_voice_trace_maintenance')
  WITH CHECK (FALSE);
CREATE POLICY realtime_voice_trace_access_maintenance_delete
  ON realtime_voice_trace_access_audits FOR DELETE
  USING (current_user = 'bob_realtime_voice_trace_maintenance');

DROP POLICY IF EXISTS tenant_isolation ON accounting_accounts;
CREATE POLICY tenant_isolation ON accounting_accounts
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON accounting_entries;
CREATE POLICY tenant_isolation ON accounting_entries
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON accounting_entry_lines;
CREATE POLICY tenant_isolation ON accounting_entry_lines
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON supplier_memory_profiles;
CREATE POLICY tenant_isolation ON supplier_memory_profiles
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- subscriptions (pilier 2) : état d'abonnement par tenant — isolation companyId standard.
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
CREATE POLICY tenant_isolation ON subscriptions
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- fiscal_profiles (BOB EXPERT FISCAL, Phase 1A) : profil fiscal par tenant — isolation companyId standard.
DROP POLICY IF EXISTS tenant_isolation ON fiscal_profiles;
CREATE POLICY tenant_isolation ON fiscal_profiles
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- line_items : rattachées via leur document parent.
DROP POLICY IF EXISTS tenant_isolation ON line_items;
CREATE POLICY tenant_isolation ON line_items
  USING (
    EXISTS (SELECT 1 FROM quotes q WHERE q.id = line_items."quoteId" AND q."companyId" = current_setting('app.current_company_id', true))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = line_items."invoiceId" AND i."companyId" = current_setting('app.current_company_id', true))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM quotes q WHERE q.id = line_items."quoteId" AND q."companyId" = current_setting('app.current_company_id', true))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = line_items."invoiceId" AND i."companyId" = current_setting('app.current_company_id', true))
  );

-- document_versions : rattachées via leur document parent.
DROP POLICY IF EXISTS tenant_isolation ON document_versions;
DROP POLICY IF EXISTS tenant_document_version_select ON document_versions;
DROP POLICY IF EXISTS tenant_document_version_insert ON document_versions;
DROP POLICY IF EXISTS tenant_document_version_update_expand ON document_versions;
CREATE POLICY tenant_document_version_select ON document_versions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM documents d WHERE d.id = document_versions."documentId" AND d."companyId" = current_setting('app.current_company_id', true))
  );
CREATE POLICY tenant_document_version_insert ON document_versions FOR INSERT
  WITH CHECK (
    public.document_version_parent_belongs_to_current_tenant_v1("documentId")
  );
-- Compatibilité N-1 strictement temporaire : son UPSERT confirme un retry par un UPDATE no-op.
-- Le trigger `document_versions_immutable` refuse toute différence ; le protocole V1 ferme en
-- plus cette policy dès l'activation, avant même le retrait de l'ACL UPDATE.
CREATE POLICY tenant_document_version_update_expand ON document_versions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_versions."documentId"
         AND d."companyId" = current_setting('app.current_company_id', true)
    )
    AND EXISTS (
      SELECT 1
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 1
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_versions."documentId"
         AND d."companyId" = current_setting('app.current_company_id', true)
    )
    AND EXISTS (
      SELECT 1
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
         AND protocol."activeVersion" = 1
    )
  );
-- Jamais de policy DELETE ; en V2, la policy UPDATE devient fausse et l'ACL est révoquée.

-- ——— Espace Cabinet V3 — identité JWT + autorisation DB ———
-- Ces helpers SECURITY DEFINER évitent les récursions de policies sur cabinet_members. Ils ne
-- renvoient qu'un booléen calculé pour app.current_user_id ; aucune ligne d'un autre tenant n'est
-- exposée. search_path est figé et row_security désactivé uniquement dans ces fonctions étroites.
CREATE OR REPLACE FUNCTION app_is_active_cabinet_member(target_cabinet_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_members m
      JOIN public.cabinets c ON c.id = m."cabinetId"
     WHERE m."cabinetId" = target_cabinet_id
       AND m."userId" = nullif(current_setting('app.current_user_id', true), '')
       AND m.status = 'active'
       AND c.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION app_has_cabinet_role(target_cabinet_id text, allowed_roles "CabinetRole"[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_members m
      JOIN public.cabinets c ON c.id = m."cabinetId"
     WHERE m."cabinetId" = target_cabinet_id
       AND m."userId" = nullif(current_setting('app.current_user_id', true), '')
       AND m.status = 'active'
       AND m.role = ANY(allowed_roles)
       AND c.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION app_is_current_cabinet_member_id(target_cabinet_id text, target_member_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_members m
     WHERE m.id = target_member_id
       AND m."cabinetId" = target_cabinet_id
       AND m."userId" = nullif(current_setting('app.current_user_id', true), '')
       AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION app_can_bootstrap_cabinet(target_cabinet_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinets c
     WHERE c.id = target_cabinet_id
       AND c."createdByUserId" = nullif(current_setting('app.current_user_id', true), '')
       AND c."bootstrapCompletedAt" IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION app_can_join_from_invitation(
  target_cabinet_id text,
  target_role "CabinetRole",
  target_invitation_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_invitations i
      JOIN public.cabinets c ON c.id = i."cabinetId"
     WHERE i."cabinetId" = target_cabinet_id
       AND i.id = target_invitation_id
       AND c.status = 'active'
       AND i.role = target_role
       AND i."emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
       AND i."tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
       AND i.status = 'accepted'
       AND i."acceptedByUserId" = nullif(current_setting('app.current_user_id', true), '')
       AND EXISTS (
         SELECT 1 FROM public.cabinet_audit_events marker
          WHERE marker.id = 'canonical:invitation-applied:' || i.id
            AND marker."cabinetId" = i."cabinetId"
            AND marker."actorUserId" = i."acceptedByUserId"
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.cabinet_members existing
          WHERE existing."sourceInvitationId" = i.id
       )
  );
$$;

CREATE OR REPLACE FUNCTION app_has_valid_cabinet_invitation(target_cabinet_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_invitations i
      JOIN public.cabinets c ON c.id = i."cabinetId"
     WHERE i."cabinetId" = target_cabinet_id
       AND c.status = 'active'
       AND i."emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
       AND i."tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
       AND (
         (i.status = 'pending' AND i."expiresAt" > CURRENT_TIMESTAMP)
         OR (
           i.status = 'accepted'
           AND i."acceptedByUserId" = nullif(current_setting('app.current_user_id', true), '')
           AND NOT EXISTS (
             SELECT 1 FROM public.cabinet_members existing
              WHERE existing."sourceInvitationId" = i.id
           )
         )
       )
  );
$$;

CREATE OR REPLACE FUNCTION app_can_advance_cabinet_join(target_cabinet_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_invitations i
      JOIN public.cabinets c ON c.id = i."cabinetId"
     WHERE i."cabinetId" = target_cabinet_id
       AND c.status = 'active'
       AND i.status = 'accepted'
       AND i."acceptedByUserId" = nullif(current_setting('app.current_user_id', true), '')
       AND i."emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
       AND i."tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
       AND NOT EXISTS (
         SELECT 1 FROM public.cabinet_members member
          WHERE member."sourceInvitationId" = i.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.cabinet_audit_events marker
          WHERE marker.id = 'canonical:invitation-applied:' || i.id
       )
  );
$$;

CREATE OR REPLACE FUNCTION app_can_manage_invitation_delivery(target_cabinet_id text, target_invitation_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cabinet_members actor
      JOIN public.cabinet_invitations invitation
        ON invitation.id = target_invitation_id
       AND invitation."cabinetId" = target_cabinet_id
      JOIN public.cabinets cabinet ON cabinet.id = target_cabinet_id
     WHERE actor."cabinetId" = target_cabinet_id
       AND actor."userId" = nullif(current_setting('app.current_user_id', true), '')
       AND actor.status = 'active'
       AND cabinet.status = 'active'
       AND invitation.status = 'pending'
       AND (
         actor.role = 'admin'
         OR (actor.role = 'manager' AND invitation.role = 'collaborator')
       )
  );
$$;

DROP POLICY IF EXISTS cabinet_select ON cabinets;
CREATE POLICY cabinet_select ON cabinets FOR SELECT
  USING (
    id = nullif(current_setting('app.current_cabinet_id', true), '')
    AND (app_is_active_cabinet_member(id) OR app_has_valid_cabinet_invitation(id))
  );

DROP POLICY IF EXISTS cabinet_bootstrap_insert ON cabinets;
CREATE POLICY cabinet_bootstrap_insert ON cabinets FOR INSERT
  WITH CHECK (
    id = nullif(current_setting('app.current_cabinet_id', true), '')
    AND "createdByUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "bootstrapCompletedAt" IS NULL
  );

DROP POLICY IF EXISTS cabinet_admin_update ON cabinets;
CREATE POLICY cabinet_admin_update ON cabinets FOR UPDATE
  USING (
    id = nullif(current_setting('app.current_cabinet_id', true), '')
    AND (
      app_has_cabinet_role(id, ARRAY['admin', 'manager']::"CabinetRole"[])
      OR app_can_advance_cabinet_join(id)
    )
  )
  WITH CHECK (
    id = nullif(current_setting('app.current_cabinet_id', true), '')
    AND (
      app_has_cabinet_role(id, ARRAY['admin', 'manager']::"CabinetRole"[])
      OR app_can_advance_cabinet_join(id)
    )
  );

DROP POLICY IF EXISTS cabinet_member_select ON cabinet_members;
CREATE POLICY cabinet_member_select ON cabinet_members FOR SELECT
  USING (
    "userId" = nullif(current_setting('app.current_user_id', true), '')
    OR (
      "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
      AND (
        app_is_active_cabinet_member("cabinetId")
        OR app_has_valid_cabinet_invitation("cabinetId")
      )
    )
  );

DROP POLICY IF EXISTS cabinet_member_insert ON cabinet_members;
CREATE POLICY cabinet_member_insert ON cabinet_members FOR INSERT
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND status = 'active'
    AND (
      (
        "userId" = nullif(current_setting('app.current_user_id', true), '')
        AND role = 'admin'
        AND "sourceInvitationId" IS NULL
        AND app_can_bootstrap_cabinet("cabinetId")
      )
      OR (
        "userId" = nullif(current_setting('app.current_user_id', true), '')
        AND "sourceInvitationId" IS NOT NULL
        AND app_can_join_from_invitation("cabinetId", role, "sourceInvitationId")
      )
    )
  );

DROP POLICY IF EXISTS cabinet_member_update ON cabinet_members;
CREATE POLICY cabinet_member_update ON cabinet_members FOR UPDATE
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND (
      app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
      OR (role = 'collaborator' AND app_has_cabinet_role("cabinetId", ARRAY['manager']::"CabinetRole"[]))
    )
  )
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND (
      app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
      OR (role = 'collaborator' AND app_has_cabinet_role("cabinetId", ARRAY['manager']::"CabinetRole"[]))
    )
  );

DROP POLICY IF EXISTS cabinet_invitation_select ON cabinet_invitations;
CREATE POLICY cabinet_invitation_select ON cabinet_invitations FOR SELECT
  USING (
    (
      "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
      AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
    )
    OR (
      "tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
      AND "emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
      AND app_has_valid_cabinet_invitation("cabinetId")
    )
  );

DROP POLICY IF EXISTS cabinet_invitation_insert ON cabinet_invitations;
CREATE POLICY cabinet_invitation_insert ON cabinet_invitations FOR INSERT
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_is_current_cabinet_member_id("cabinetId", "invitedByMemberId")
    AND status = 'pending'
    AND (
      app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
      OR (
        role = 'collaborator'
        AND app_has_cabinet_role("cabinetId", ARRAY['manager']::"CabinetRole"[])
      )
    )
  );

DROP POLICY IF EXISTS cabinet_invitation_update ON cabinet_invitations;
CREATE POLICY cabinet_invitation_update ON cabinet_invitations FOR UPDATE
  USING (
    (
      "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
      AND (
        app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
        OR (role = 'collaborator' AND app_has_cabinet_role("cabinetId", ARRAY['manager']::"CabinetRole"[]))
      )
    )
    OR (
      "tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
      AND "emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
      AND status = 'pending'
      AND "expiresAt" > CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM public.cabinets active_cabinet
         WHERE active_cabinet.id = "cabinetId" AND active_cabinet.status = 'active'
      )
    )
  )
  WITH CHECK (
    (
      "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
      AND (
        app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
        OR (role = 'collaborator' AND app_has_cabinet_role("cabinetId", ARRAY['manager']::"CabinetRole"[]))
      )
      AND (
        status = 'revoked'
        OR (status = 'expired' AND "expiresAt" <= CURRENT_TIMESTAMP)
      )
    )
    OR (
      "tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
      AND "emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
      AND status = 'accepted'
      AND "acceptedByUserId" = nullif(current_setting('app.current_user_id', true), '')
      AND "acceptedAt" IS NOT NULL
      AND "revokedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM public.cabinets active_cabinet
         WHERE active_cabinet.id = "cabinetId" AND active_cabinet.status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS cabinet_audit_select ON cabinet_audit_events;
CREATE POLICY cabinet_audit_select ON cabinet_audit_events FOR SELECT
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_is_active_cabinet_member("cabinetId")
  );

DROP POLICY IF EXISTS cabinet_audit_insert ON cabinet_audit_events;
CREATE POLICY cabinet_audit_insert ON cabinet_audit_events FOR INSERT
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND "actorUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
  );

-- Dossiers/FEC : tant que les assignations collaborateur ne sont pas matérialisées, seuls
-- admin et manager voient le portefeuille. La suppression, plus sensible, reste admin-only.
DROP POLICY IF EXISTS cabinet_dossier_select ON cabinet_dossiers;
DROP POLICY IF EXISTS cabinet_dossier_insert ON cabinet_dossiers;
DROP POLICY IF EXISTS cabinet_dossier_update ON cabinet_dossiers;
DROP POLICY IF EXISTS cabinet_dossier_delete ON cabinet_dossiers;
CREATE POLICY cabinet_dossier_select ON cabinet_dossiers FOR SELECT
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
  );
CREATE POLICY cabinet_dossier_insert ON cabinet_dossiers FOR INSERT
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
  );
CREATE POLICY cabinet_dossier_update ON cabinet_dossiers FOR UPDATE
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
  )
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin', 'manager']::"CabinetRole"[])
  );
CREATE POLICY cabinet_dossier_delete ON cabinet_dossiers FOR DELETE
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_has_cabinet_role("cabinetId", ARRAY['admin']::"CabinetRole"[])
  );

DROP POLICY IF EXISTS cabinet_invitation_delivery_select ON cabinet_invitation_deliveries;
CREATE POLICY cabinet_invitation_delivery_select ON cabinet_invitation_deliveries FOR SELECT
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_can_manage_invitation_delivery("cabinetId", "invitationId")
  );

DROP POLICY IF EXISTS cabinet_invitation_delivery_insert ON cabinet_invitation_deliveries;
CREATE POLICY cabinet_invitation_delivery_insert ON cabinet_invitation_deliveries FOR INSERT
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_can_manage_invitation_delivery("cabinetId", "invitationId")
  );

DROP POLICY IF EXISTS cabinet_invitation_delivery_update ON cabinet_invitation_deliveries;
CREATE POLICY cabinet_invitation_delivery_update ON cabinet_invitation_deliveries FOR UPDATE
  USING (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_can_manage_invitation_delivery("cabinetId", "invitationId")
  )
  WITH CHECK (
    "cabinetId" = nullif(current_setting('app.current_cabinet_id', true), '')
    AND app_can_manage_invitation_delivery("cabinetId", "invitationId")
  );

DROP POLICY IF EXISTS release_flag_identity_select ON release_flags;
CREATE POLICY release_flag_identity_select ON release_flags FOR SELECT
  USING (nullif(current_setting('app.current_user_id', true), '') IS NOT NULL);

DROP POLICY IF EXISTS release_flag_subject_select ON release_flag_subjects;
CREATE POLICY release_flag_subject_select ON release_flag_subjects FOR SELECT
  USING (
    ("subjectType" = 'user' AND "subjectId" = nullif(current_setting('app.current_user_id', true), ''))
    OR (
      "subjectType" = 'cabinet'
      AND "subjectId" = nullif(current_setting('app.current_cabinet_id', true), '')
      AND (
        app_is_active_cabinet_member("subjectId")
        OR app_has_valid_cabinet_invitation("subjectId")
      )
    )
  );

-- Aucune policy d'écriture runtime sur release_flags/release_flag_subjects. Les valeurs globales,
-- kill-switches et ciblages sont des opérations de release via le rôle privilégié/CI audité,
-- jamais un réglage qu'un admin cabinet peut auto-activer.
-- release_flag_audit_events n'a volontairement AUCUNE policy : invisible et non insérable par bob_app.

-- Les fences AgentMission sont partagées avec la preuve PostgreSQL 17 afin que le replay
-- certifié soit exactement celui de la release.
\ir agent-mission-realtime-rls-replay.sql
