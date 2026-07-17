-- Bob Pro — Row Level Security (défense en profondeur multi-tenant).
-- Tenant courant = current_setting('app.current_company_id'). L'app doit le poser par requête
-- (SET LOCAL app.current_company_id = '<companyId>' dans une transaction) et se connecter avec
-- un rôle applicatif. FORCE garantit que même le propriétaire de la table est soumis aux politiques.
-- À exécuter après les migrations Prisma : psql "$DATABASE_URL" -f prisma/rls.sql

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'companies',
    'company_billing_settings',
    'customers',
    'quotes',
    'invoices',
    'line_items',
    'payments',
    'public_access_tokens',
    'expenses',
    'expense_creation_requests',
    'quote_creation_requests',
    'quote_draft_slots',
    'documents',
    'document_analyses',
    'document_folders',
    'document_folder_deletion_plans',
    'document_versions',
    'document_archive_jobs',
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
    'chantiers',
    'chantier_notes',
    'chantier_photos',
    'subscriptions',
    'fiscal_profiles',
    'document_counters',
    'realtime_admission_events',
    'realtime_session_leases',
    'realtime_mistral_ingress_tickets',
    'realtime_speech_artifacts',
    'realtime_control_grants',
    'realtime_control_consumptions',
    'realtime_voice_usage_events',
    'realtime_voice_usage_daily',
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
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  USING (id = current_setting('app.current_company_id', true))
  WITH CHECK (id = current_setting('app.current_company_id', true));

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

DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
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

DROP POLICY IF EXISTS tenant_isolation ON catalogue_prestations;
CREATE POLICY tenant_isolation ON catalogue_prestations
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

DROP POLICY IF EXISTS tenant_isolation ON quotes;
CREATE POLICY tenant_isolation ON quotes
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON invoices;
CREATE POLICY tenant_isolation ON invoices
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

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
CREATE POLICY tenant_isolation ON documents
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

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

DROP POLICY IF EXISTS tenant_isolation ON realtime_session_leases;
CREATE POLICY tenant_isolation ON realtime_session_leases
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON realtime_mistral_ingress_tickets;
CREATE POLICY tenant_isolation ON realtime_mistral_ingress_tickets
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

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
CREATE POLICY tenant_isolation ON document_archive_jobs
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

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
CREATE POLICY tenant_isolation ON document_versions
  USING (
    EXISTS (SELECT 1 FROM documents d WHERE d.id = document_versions."documentId" AND d."companyId" = current_setting('app.current_company_id', true))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM documents d WHERE d.id = document_versions."documentId" AND d."companyId" = current_setting('app.current_company_id', true))
  );

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
