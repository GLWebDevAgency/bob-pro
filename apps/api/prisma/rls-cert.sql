\set ON_ERROR_STOP on

-- Certification RLS Bob Pro.
-- Preconditions:
-- - Prisma migrations applied
-- - prisma/rls.sql applied
-- - current connection uses the application role, not postgres/superuser

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'RLS cert failed (%): expected %, got %', label, expected, actual;
  END IF;
END;
$$;

SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN rolsuper THEN 1 ELSE 0 END::bigint FROM pg_roles WHERE rolname = current_user),
  0,
  'cert role is not superuser'
);
SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN rolbypassrls THEN 1 ELSE 0 END::bigint FROM pg_roles WHERE rolname = current_user),
  0,
  'cert role cannot bypass RLS'
);
SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END::bigint
     FROM pg_class
    WHERE oid = 'public.realtime_reaper_tenant_schedule'::regclass),
  1,
  'realtime reaper tenant schedule has enabled and forced RLS'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_reaper_tenant_schedule'),
  5,
  'realtime reaper tenant schedule exposes exactly five policies'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS required(privilege_name)
    WHERE has_table_privilege(
      current_user, 'public.realtime_reaper_tenant_schedule', required.privilege_name
    )),
  4,
  'runtime role can reconcile only its tenant reaper schedule'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(
    current_user,
    'public.realtime_reaper_tenant_schedule',
    'TRUNCATE, REFERENCES, TRIGGER'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot truncate, reference or retarget the reaper schedule'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(
    current_user,
    'public.realtime_reaper_directory_cursor',
    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot access the global reaper cursor'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.sync_realtime_reaper_tenant_schedule_v1()',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke the schedule trigger authority directly'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM unnest(ARRAY[
       'public.list_realtime_reaper_tenants_v1(integer,uuid)',
       'public.ack_realtime_reaper_tenants_v1(uuid)',
       'public.renew_realtime_reaper_tenants_claim_v1(uuid)'
     ]) AS capability(signature)
    WHERE has_function_privilege(current_user, capability.signature, 'EXECUTE')),
  3,
  'runtime role receives the three bounded reaper directory capabilities'
);
SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END::bigint
     FROM pg_class
    WHERE oid = 'public.realtime_native_speech_deliveries'::regclass),
  1,
  'native speech delivery has enabled and forced RLS'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'realtime_native_speech_maintenance_cursors'),
  2,
  'native maintenance cursor exposes no extra policy'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'),
  6,
  'native speech delivery exposes exactly six policies'
);
SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END::bigint
     FROM pg_class
    WHERE oid = 'public.realtime_native_speech_maintenance_cursors'::regclass),
  1,
  'native maintenance cursor has enabled and forced RLS during rolling deploy'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'realtime_native_speech_maintenance_cursors'
      AND policyname IN (
        'realtime_native_speech_maintenance_cursor_directory_select',
        'realtime_native_speech_maintenance_cursor_directory_update'
      )
      AND permissive = 'PERMISSIVE'
      AND qual LIKE '%bob_openai_native_maintenance_directory%'),
  2,
  'native maintenance cursor exposes exactly two directory-only policies'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_due_directory_select'
      AND cmd = 'SELECT' AND permissive = 'PERMISSIVE'
      AND qual LIKE '%bob_openai_native_maintenance_directory%'
      AND qual LIKE '%expiresAt%'
      AND qual LIKE '%retentionExpiresAt%'),
  1,
  'native speech due-directory policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_select' AND cmd = 'SELECT'),
  1,
  'native speech delivery select policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_insert' AND cmd = 'INSERT'),
  1,
  'native speech delivery insert policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_update' AND cmd = 'UPDATE'),
  1,
  'native speech delivery update policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_delete_tenant'
      AND cmd = 'DELETE' AND permissive = 'PERMISSIVE'),
  1,
  'native speech delivery delete tenant policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_native_speech_deliveries'
      AND policyname = 'realtime_native_speech_delivery_delete_retention_fence'
      AND cmd = 'DELETE' AND permissive = 'RESTRICTIVE'
      AND qual LIKE '%retentionExpiresAt%'
      AND qual LIKE '%realtime_control_grants%'),
  1,
  'native speech delivery restrictive retention policy exact'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM pg_attribute
    WHERE attrelid = 'public.realtime_native_speech_deliveries'::regclass
      AND attname = ANY (ARRAY[
        'dispatchingAt', 'requestedAt', 'acceptedAt', 'streamingAt',
        'responseDoneAt', 'outputStoppedAt', 'completedAt', 'deliveredAt',
        'terminalAt', 'createdAt', 'expiresAt', 'retentionExpiresAt'
      ]::TEXT[])
      AND format_type(atttypid, atttypmod) = 'timestamp(3) with time zone'),
  12,
  'native speech machine timestamps persist exact JavaScript millisecond precision'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM pg_constraint
    WHERE conrelid = 'public.realtime_native_speech_deliveries'::regclass
      AND conname = 'realtime_native_speech_deliveries_finite_timestamps_check'
      AND pg_get_constraintdef(oid) LIKE '%isfinite%'),
  1,
  'native speech delivery rejects non-finite machine timestamps'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM pg_constraint
    WHERE conrelid = 'public.realtime_control_grants'::regclass
      AND conname = 'realtime_control_grants_provider_stream_v1_disabled_check'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%provider_stream%'),
  1,
  'native provider_stream controls remain physically disabled in V1'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_native_speech_deliveries', 'SELECT') THEN 1 ELSE 0 END,
  1,
  'runtime role can read native speech deliveries'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_native_speech_deliveries', 'INSERT') THEN 1 ELSE 0 END,
  1,
  'runtime role can prepare native speech deliveries'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_native_speech_deliveries', 'UPDATE') THEN 1 ELSE 0 END,
  1,
  'runtime role can perform native speech CAS updates'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_native_speech_deliveries', 'DELETE') THEN 1 ELSE 0 END,
  1,
  'runtime role can invoke the tenant and retention fenced native purge'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(
    current_user,
    'public.realtime_native_speech_deliveries',
    'TRUNCATE, REFERENCES, TRIGGER'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot truncate, reference or retarget native speech deliveries'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.assert_realtime_native_delivery_fence_v1(text,character,uuid,text,integer,character,character,integer)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke native speech fence directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.guard_realtime_native_delivery_v1()',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke native speech transition guard directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.guard_realtime_native_speech_slo_v1()',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke native speech SLO guard directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.guard_realtime_native_delivery_delete_v1()',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke native speech delete guard directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.deny_realtime_native_delivery_truncate_v1()',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot invoke native speech truncate guard directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.list_realtime_native_speech_maintenance_tenants_v1(text,integer,uuid)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can invoke only the bounded native due-directory capability'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.ack_realtime_native_speech_maintenance_tenants_v1(text,uuid)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can ACK only its opaque native maintenance claim'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.renew_realtime_native_speech_maintenance_claim_v1(text,uuid)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can heartbeat only its opaque native maintenance claim'
);
SELECT pg_temp.assert_eq(
  CASE WHEN pg_has_role(
    current_user,
    'bob_openai_native_maintenance_directory',
    'SET'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot SET ROLE to the native maintenance directory owner'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(
    current_user,
    'public.realtime_native_speech_maintenance_cursors',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot read or mutate native maintenance cursors directly'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.realtime_native_speech_maintenance_cursors'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND has_column_privilege(
        current_user, attribute.attrelid, attribute.attnum,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )),
  0,
  'runtime role has no inherited native cursor column privilege'
);
SELECT pg_temp.assert_eq(
  (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END::bigint
     FROM pg_class
    WHERE oid = 'public.realtime_reaper_directory_cursor'::regclass),
  1,
  'realtime reaper directory cursor has enabled and forced RLS'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'realtime_reaper_directory_cursor'
      AND policyname IN (
        'realtime_reaper_directory_cursor_select',
        'realtime_reaper_directory_cursor_update'
      )
      AND permissive = 'PERMISSIVE'
      AND qual LIKE '%bob_realtime_reaper_directory%'),
  2,
  'realtime reaper cursor exposes exactly two directory-only policies'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user, 'public.list_realtime_reaper_tenants_v1(integer,uuid)', 'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can invoke the bounded realtime reaper directory'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user, 'public.ack_realtime_reaper_tenants_v1(uuid)', 'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can ACK only its opaque realtime reaper claim'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user, 'public.renew_realtime_reaper_tenants_claim_v1(uuid)', 'EXECUTE'
  ) THEN 1 ELSE 0 END,
  1,
  'runtime role can heartbeat only its opaque realtime reaper claim'
);
SELECT pg_temp.assert_eq(
  CASE WHEN pg_has_role(current_user, 'bob_realtime_reaper_directory', 'SET')
    THEN 1 ELSE 0 END,
  0,
  'runtime role cannot SET ROLE to realtime reaper directory owner'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(
    current_user, 'public.realtime_reaper_directory_cursor',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot read or mutate realtime reaper cursor directly'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.realtime_reaper_directory_cursor'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND has_column_privilege(
        current_user, attribute.attrelid, attribute.attnum,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )),
  0,
  'runtime role has no inherited realtime reaper cursor column privilege'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.assert_realtime_control_grant_binding_v3(text,integer,uuid,uuid,text,uuid,uuid,integer,character,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot inspect control delivery bindings directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_function_privilege(
    current_user,
    'public.assert_realtime_control_consumption_binding_v3(text,uuid,uuid,uuid,uuid,timestamp with time zone)',
    'EXECUTE'
  ) THEN 1 ELSE 0 END,
  0,
  'runtime role cannot inspect control consumption bindings directly'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.companies', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot hard-delete companies'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.documents', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot hard-delete documents'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.document_versions', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot hard-delete document versions'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.document_analyses', 'UPDATE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot update document analyses'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.document_analyses', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot delete document analyses'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.expense_creation_requests', 'UPDATE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot update expense creation requests'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.expense_creation_requests', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot delete expense creation requests'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.quote_creation_requests', 'UPDATE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot update quote creation requests'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.quote_creation_requests', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot delete quote creation requests'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_speech_artifacts', 'DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot directly delete realtime speech artifacts'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_control_grants', 'UPDATE, DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot mutate realtime control grants'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_control_consumptions', 'UPDATE, DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot mutate realtime control consumptions'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_voice_usage_events', 'UPDATE, DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot mutate realtime voice usage events'
);
SELECT pg_temp.assert_eq(
  CASE WHEN has_table_privilege(current_user, 'public.realtime_voice_usage_daily', 'INSERT, UPDATE, DELETE') THEN 1 ELSE 0 END,
  0,
  'runtime role cannot forge realtime voice daily aggregates'
);

-- Protocole outbox v2 : posé par PrismaService.withTenant. Une révision N-1 qui ne le
-- connaît pas doit voir zéro job et ne peut effectuer aucune mutation.
SELECT set_config('app.notification_outbox_version', '2', false);
-- Le trigger de spool reste actif durant la certification pre-deploy ; seules les fixtures
-- contrôlées le contournent. La preuve N-1 en fin de fichier réactive le comportement réel.
SELECT set_config('app.notification_outbox_cutover_bypass', 'certification', false);

-- La même certification s'exécute pendant l'expand V1 puis après le cutover V2. Les fixtures
-- archive doivent donc emprunter exactement la capacité encore autorisée dans chaque protocole.
SELECT ("activeVersion" = 1) AS document_archive_expand
  FROM public.document_archive_protocol_state
 WHERE id = 1
\gset

-- Fixture cleanup is intentionally privileged and is executed before and after this file by
-- release.sh. The runtime role must never acquire hard-delete rights merely to make a cert rerunnable.

-- Seed tenant A through RLS WITH CHECK policies.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
INSERT INTO companies (id, name, "legalForm", siren, siret, trade, "vatRegime", "addrLine1", "addrZip", "addrCity")
VALUES ('rls-co-a', 'RLS Company A', 'EI', '111111111', '11111111100011', 'btp', 'reel_normal', '1 rue A', '75001', 'Paris');
INSERT INTO document_folders (id, "companyId", name, "normalizedName", status, revision, "createdAt", "updatedAt")
VALUES ('rls-folder-a', 'rls-co-a', 'Archives A', 'archives a', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO document_folder_deletion_plans (
  id, "companyId", "folderId", "expectedRevision", "expectedSnapshot", "createdAt", "expiresAt"
)
VALUES (
  'rls-folder-plan-a', 'rls-co-a', 'rls-folder-a', 1,
  '{"folders":[{"id":"rls-folder-a","parentId":null,"revision":1}],"documents":[]}'::jsonb,
  '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'
);
INSERT INTO customers (id, "companyId", type, name, "addrLine1", "addrZip", "addrCity")
VALUES ('rls-customer-a', 'rls-co-a', 'b2c', 'Client A', '1 rue A', '75001', 'Paris');
INSERT INTO quotes (id, "companyId", "customerId", status)
VALUES ('rls-quote-a', 'rls-co-a', 'rls-customer-a', 'sent');
INSERT INTO invoices (
  id, "companyId", "customerId", kind, status, number, "issuedAt", "dueAt"
)
VALUES (
  'rls-invoice-a', 'rls-co-a', 'rls-customer-a', 'invoice', 'issued',
  'RLS-A-2026-001', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'
);
INSERT INTO line_items (id, "quoteId", position, label, category, qty, "unitPriceHt", "vatRate")
VALUES ('rls-line-a', 'rls-quote-a', 1, 'Line A', 'labor', 1, 10000, 20);
INSERT INTO payments (id, "companyId", "invoiceId", amount, method, "receivedAt")
VALUES ('rls-payment-a', 'rls-co-a', 'rls-invoice-a', 10000, 'transfer', '2026-01-01T00:00:00Z');
INSERT INTO public_access_tokens (id, "companyId", "tokenHash", "resourceType", "resourceId", scope, "expiresAt")
VALUES ('rls-token-a', 'rls-co-a', 'rls-hash-a', 'quote', 'rls-quote-a', 'quote_signature', '2026-12-31T00:00:00Z');
INSERT INTO expenses (id, "companyId", "supplierName", "documentDate", "totalTtcCents", category)
VALUES ('rls-expense-a', 'rls-co-a', 'Supplier A', '2026-01-01', 10000, 'materials');
INSERT INTO supplier_memory_profiles (
  id, "companyId", key, "displayName", siren, category, "vatRatePct", seen, "lastSeenAt", "updatedAt"
)
VALUES (
  'rls-supplier-a', 'rls-co-a', 'supplier a', 'Supplier A', '552100554', 'materiel', 20, 1,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO subscriptions (id, "companyId", plan, status, "trialEndsAt", "createdAt", "updatedAt")
VALUES ('rls-subscription-a', 'rls-co-a', 'pro', 'trialing', '2026-01-15T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO fiscal_profiles (
  id, "companyId", "legalForm", "taxRegime", "socialStatus", "activityNature", "vatRegime", "acre",
  "versementLiberatoire", "fiscalYearEnd", "createdAt", "updatedAt"
)
VALUES (
  'rls-fiscal-profile-a', 'rls-co-a', '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO documents (
  id, "companyId", kind, origin, status, filename, "mimeType", "byteSize", sha256, "storageKey",
  "linkedEntityType", "linkedEntityId", "documentDate", "issuedAt", "createdAt", "createdBy", "retentionUntil", "deletedAt"
)
VALUES (
  'rls-doc-a', 'rls-co-a', 'expense_receipt', 'ocr', 'active', 'receipt-a.jpg', 'image/jpeg', 12, repeat('a', 64),
  'companies/rls-co-a/documents/rls-doc-a/v1/' || repeat('a', 64) || '.jpg',
  'expense', 'rls-expense-a', '2026-01-01', NULL, '2026-01-01T00:00:00Z', 'rls-cert', '2036-01-01', NULL
);
INSERT INTO document_versions (id, "documentId", version, "storageKey", sha256, "mimeType", "byteSize", "createdAt", reason)
VALUES (
  'rls-docver-a', 'rls-doc-a', 1, 'companies/rls-co-a/documents/rls-doc-a/v1/' || repeat('a', 64) || '.jpg',
  repeat('a', 64), 'image/jpeg', 12, '2026-01-01T00:00:00Z', 'initial'
);
INSERT INTO document_analyses (
  "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
  "analysisSchemaVersion", analysis, "analyzedAt"
)
VALUES (
  'rls-co-a', 'rls-doc-a', 1, repeat('a', 64), 'rls-cert-v1', 1,
  jsonb_build_object(
    'documentId', 'rls-doc-a', 'documentVersion', 1, 'sourceSha256', repeat('a', 64),
    'type', 'receipt', 'typeConfidence', 0.95, 'summary', 'Justificatif A certifié.',
    'facts', jsonb_build_array(
      jsonb_build_object(
        'key', 'supplier_name', 'valueType', 'text', 'value', 'Supplier A', 'confidence', 0.95,
        'provenance', jsonb_build_object(
          'source', 'document_text',
          'evidence', jsonb_build_array(jsonb_build_object(
            'page', 1, 'excerpt', 'Supplier A', 'boundingBox', NULL
          )),
          'derivedFrom', jsonb_build_array(), 'rule', NULL
        )
      ),
      jsonb_build_object(
        'key', 'document_date', 'valueType', 'date', 'value', '2026-01-01', 'confidence', 0.93,
        'provenance', jsonb_build_object(
          'source', 'document_text',
          'evidence', jsonb_build_array(jsonb_build_object(
            'page', 1, 'excerpt', '01/01/2026', 'boundingBox', NULL
          )),
          'derivedFrom', jsonb_build_array(), 'rule', NULL
        )
      ),
      jsonb_build_object(
        'key', 'total_ttc', 'valueType', 'money',
        'value', jsonb_build_object('amountMinor', 10000, 'currency', 'EUR'), 'confidence', 0.94,
        'provenance', jsonb_build_object(
          'source', 'document_visual',
          'evidence', jsonb_build_array(jsonb_build_object(
            'page', 1, 'excerpt', NULL,
            'boundingBox', jsonb_build_object('x', 0.1, 'y', 0.7, 'width', 0.3, 'height', 0.08)
          )),
          'derivedFrom', jsonb_build_array(), 'rule', NULL
        )
      ),
      jsonb_build_object(
        'key', 'tax_amount', 'valueType', 'money',
        'value', jsonb_build_object('amountMinor', 1667, 'currency', 'EUR'), 'confidence', 0.9,
        'provenance', jsonb_build_object(
          'source', 'derived', 'evidence', jsonb_build_array(),
          'derivedFrom', jsonb_build_array('total_ttc'), 'rule', 'fixture-vat-calculation'
        )
      )
    ),
    'suggestedTags', jsonb_build_array('receipt', 'supplier-a'),
    'suggestedFilename', 'receipt-a', 'suggestedSystemFolder', 'purchases',
    'warnings', jsonb_build_array(), 'requiresHumanReview', false,
    'analyzerVersion', 'rls-cert-v1', 'analyzedAt', '2026-01-01T00:00:00.000Z'
  ),
  '2026-01-01T00:00:00.000Z'
);
INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
VALUES ('rls-co-a', 'quote', 2026, 2);
\if :document_archive_expand
  INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
  VALUES ('rls-archive-a', 'rls-co-a', 'rls-invoice-a', 'invoice-issued-pdf-only-b2c', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
\else
  SELECT pg_temp.assert_eq(
    CASE WHEN public.document_archive_job_enqueue_v2(
      'rls-archive-a', 'rls-co-a', 'rls-invoice-a', 'invoice-issued-pdf-only-b2c'
    ) THEN 1 ELSE 0 END,
    1,
    'tenant A archive job enqueued through V2 capability'
  );
\endif
INSERT INTO notification_jobs (
  id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload, "payloadFingerprint",
  status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8000-00000000000a', 'rls-co-a', 'quote-signature', 'quote:rls-quote-a', 'email', 'client-a@example.com', 'Devis A',
  '{"channel":"email","to":"client-a@example.com","subject":"Devis A","body":"Lien A","idempotencyKey":"00000000-0000-4000-8000-00000000000a"}'::jsonb,
  'cert-a', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO agent_journal_entries (
  id, "companyId", "runId", seq, at, phase, tool, label, args, mutating, outbound, compliance, reason, "resultDigest"
)
VALUES (
  'rls-agent-journal-a', 'rls-co-a', 'rls-run-a', 1, '2026-01-01T00:00:00Z', 'planned',
  'encaisser_facture', 'Encaisser F-001', '{"invoiceId":"rls-invoice-a"}'::jsonb, true, false, 'high', NULL, NULL
);
INSERT INTO accounting_accounts (
  "companyId", code, label, kind, "normalSide", "parentCode", active, "postingAllowed", "updatedAt"
)
VALUES
  ('rls-co-a', '411', 'Clients', 'asset', 'debit', NULL, true, true, '2026-01-01T00:00:00Z'),
  ('rls-co-a', '706', 'Prestations de services', 'revenue', 'credit', NULL, true, true, '2026-01-01T00:00:00Z');
INSERT INTO accounting_entries (
  id, "companyId", journal, "sourceType", "sourceId", "entryDate", reference, label, "createdAt"
)
VALUES (
  'rls-accentry-a', 'rls-co-a', 'sales', 'invoice', 'rls-invoice-a', '2026-01-01', 'F-001', 'Facture F-001',
  '2026-01-01T00:00:00Z'
);
INSERT INTO accounting_entry_lines (
  id, "companyId", "entryId", position, account, label, "debitCents", "creditCents"
)
VALUES
  ('rls-accline-a-1', 'rls-co-a', 'rls-accentry-a', 1, '411', 'Client A', 10000, 0),
  ('rls-accline-a-2', 'rls-co-a', 'rls-accentry-a', 2, '706', 'Vente A', 0, 10000);
COMMIT;

-- Seed tenant B through RLS WITH CHECK policies.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-b';
INSERT INTO companies (id, name, "legalForm", siren, siret, trade, "vatRegime", "addrLine1", "addrZip", "addrCity")
VALUES ('rls-co-b', 'RLS Company B', 'EI', '222222222', '22222222200022', 'btp', 'reel_normal', '2 rue B', '69001', 'Lyon');
INSERT INTO document_folders (id, "companyId", name, "normalizedName", status, revision, "createdAt", "updatedAt")
VALUES ('rls-folder-b', 'rls-co-b', 'Archives B', 'archives b', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO document_folder_deletion_plans (
  id, "companyId", "folderId", "expectedRevision", "expectedSnapshot", "createdAt", "expiresAt"
)
VALUES (
  'rls-folder-plan-b', 'rls-co-b', 'rls-folder-b', 1,
  '{"folders":[{"id":"rls-folder-b","parentId":null,"revision":1}],"documents":[]}'::jsonb,
  '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'
);
INSERT INTO customers (id, "companyId", type, name, "addrLine1", "addrZip", "addrCity")
VALUES ('rls-customer-b', 'rls-co-b', 'b2c', 'Client B', '2 rue B', '69001', 'Lyon');
INSERT INTO quotes (id, "companyId", "customerId", status)
VALUES ('rls-quote-b', 'rls-co-b', 'rls-customer-b', 'sent');
INSERT INTO invoices (
  id, "companyId", "customerId", kind, status, number, "issuedAt", "dueAt"
)
VALUES (
  'rls-invoice-b', 'rls-co-b', 'rls-customer-b', 'invoice', 'issued',
  'RLS-B-2026-001', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'
);
INSERT INTO line_items (id, "quoteId", position, label, category, qty, "unitPriceHt", "vatRate")
VALUES ('rls-line-b', 'rls-quote-b', 1, 'Line B', 'labor', 1, 20000, 20);
INSERT INTO payments (id, "companyId", "invoiceId", amount, method, "receivedAt")
VALUES ('rls-payment-b', 'rls-co-b', 'rls-invoice-b', 20000, 'transfer', '2026-01-01T00:00:00Z');
INSERT INTO public_access_tokens (id, "companyId", "tokenHash", "resourceType", "resourceId", scope, "expiresAt")
VALUES ('rls-token-b', 'rls-co-b', 'rls-hash-b', 'quote', 'rls-quote-b', 'quote_signature', '2026-12-31T00:00:00Z');
INSERT INTO expenses (id, "companyId", "supplierName", "documentDate", "totalTtcCents", category)
VALUES ('rls-expense-b', 'rls-co-b', 'Supplier B', '2026-01-01', 20000, 'materials');
INSERT INTO supplier_memory_profiles (
  id, "companyId", key, "displayName", siren, category, "vatRatePct", seen, "lastSeenAt", "updatedAt"
)
VALUES (
  'rls-supplier-b', 'rls-co-b', 'supplier b', 'Supplier B', '732829320', 'carburant', 20, 1,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO subscriptions (id, "companyId", plan, status, "trialEndsAt", "createdAt", "updatedAt")
VALUES ('rls-subscription-b', 'rls-co-b', 'solo', 'active', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO fiscal_profiles (
  id, "companyId", "legalForm", "taxRegime", "socialStatus", "activityNature", "vatRegime", "acre",
  "versementLiberatoire", "fiscalYearEnd", "createdAt", "updatedAt"
)
VALUES (
  'rls-fiscal-profile-b', 'rls-co-b', '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO documents (
  id, "companyId", kind, origin, status, filename, "mimeType", "byteSize", sha256, "storageKey",
  "linkedEntityType", "linkedEntityId", "documentDate", "issuedAt", "createdAt", "createdBy", "retentionUntil", "deletedAt"
)
VALUES (
  'rls-doc-b', 'rls-co-b', 'expense_receipt', 'ocr', 'active', 'receipt-b.jpg', 'image/jpeg', 12, repeat('b', 64),
  'companies/rls-co-b/documents/rls-doc-b/v1/' || repeat('b', 64) || '.jpg',
  'expense', 'rls-expense-b', '2026-01-01', NULL, '2026-01-01T00:00:00Z', 'rls-cert', '2036-01-01', NULL
);
INSERT INTO document_versions (id, "documentId", version, "storageKey", sha256, "mimeType", "byteSize", "createdAt", reason)
VALUES (
  'rls-docver-b', 'rls-doc-b', 1, 'companies/rls-co-b/documents/rls-doc-b/v1/' || repeat('b', 64) || '.jpg',
  repeat('b', 64), 'image/jpeg', 12, '2026-01-01T00:00:00Z', 'initial'
);
INSERT INTO document_analyses (
  "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
  "analysisSchemaVersion", analysis, "analyzedAt"
)
VALUES (
  'rls-co-b', 'rls-doc-b', 1, repeat('b', 64), 'rls-cert-v1', 1,
  jsonb_build_object(
    'documentId', 'rls-doc-b', 'documentVersion', 1, 'sourceSha256', repeat('b', 64),
    'type', 'receipt', 'typeConfidence', 0.95, 'summary', 'Justificatif B certifié.',
    'facts', jsonb_build_array(), 'suggestedTags', jsonb_build_array('receipt'),
    'suggestedFilename', 'receipt-b', 'suggestedSystemFolder', 'purchases',
    'warnings', jsonb_build_array(), 'requiresHumanReview', true,
    'analyzerVersion', 'rls-cert-v1', 'analyzedAt', '2026-01-01T00:00:00.000Z'
  ),
  '2026-01-01T00:00:00.000Z'
);
INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
VALUES ('rls-co-b', 'quote', 2026, 2);
\if :document_archive_expand
  INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
  VALUES ('rls-archive-b', 'rls-co-b', 'rls-invoice-b', 'invoice-issued-pdf-only-b2c', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
\else
  SELECT pg_temp.assert_eq(
    CASE WHEN public.document_archive_job_enqueue_v2(
      'rls-archive-b', 'rls-co-b', 'rls-invoice-b', 'invoice-issued-pdf-only-b2c'
    ) THEN 1 ELSE 0 END,
    1,
    'tenant B archive job enqueued through V2 capability'
  );
\endif
INSERT INTO notification_jobs (
  id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload, "payloadFingerprint",
  status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8000-00000000000b', 'rls-co-b', 'quote-signature', 'quote:rls-quote-b', 'email', 'client-b@example.com', 'Devis B',
  '{"channel":"email","to":"client-b@example.com","subject":"Devis B","body":"Lien B","idempotencyKey":"00000000-0000-4000-8000-00000000000b"}'::jsonb,
  'cert-b', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO agent_journal_entries (
  id, "companyId", "runId", seq, at, phase, tool, label, args, mutating, outbound, compliance, reason, "resultDigest"
)
VALUES (
  'rls-agent-journal-b', 'rls-co-b', 'rls-run-b', 1, '2026-01-01T00:00:00Z', 'planned',
  'encaisser_facture', 'Encaisser F-002', '{"invoiceId":"rls-invoice-b"}'::jsonb, true, false, 'high', NULL, NULL
);
INSERT INTO accounting_accounts (
  "companyId", code, label, kind, "normalSide", "parentCode", active, "postingAllowed", "updatedAt"
)
VALUES
  ('rls-co-b', '411', 'Clients', 'asset', 'debit', NULL, true, true, '2026-01-01T00:00:00Z'),
  ('rls-co-b', '706', 'Prestations de services', 'revenue', 'credit', NULL, true, true, '2026-01-01T00:00:00Z');
INSERT INTO accounting_entries (
  id, "companyId", journal, "sourceType", "sourceId", "entryDate", reference, label, "createdAt"
)
VALUES (
  'rls-accentry-b', 'rls-co-b', 'sales', 'invoice', 'rls-invoice-b', '2026-01-01', 'F-002', 'Facture F-002',
  '2026-01-01T00:00:00Z'
);
INSERT INTO accounting_entry_lines (
  id, "companyId", "entryId", position, account, label, "debitCents", "creditCents"
)
VALUES
  ('rls-accline-b-1', 'rls-co-b', 'rls-accentry-b', 1, '411', 'Client B', 20000, 0),
  ('rls-accline-b-2', 'rls-co-b', 'rls-accentry-b', 2, '706', 'Vente B', 0, 20000);
COMMIT;

-- Tenant A can see A and cannot see B, including child tables.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM companies), 1, 'companies tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM customers), 1, 'customers tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes), 1, 'quotes tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM invoices), 1, 'invoices tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM line_items), 1, 'line_items tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM payments), 1, 'payments tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public_access_tokens), 1, 'public_access_tokens tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM expenses), 1, 'expenses tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM supplier_memory_profiles), 1, 'supplier_memory_profiles tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM subscriptions), 1, 'subscriptions tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM fiscal_profiles), 1, 'fiscal_profiles tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents), 1, 'documents tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_analyses), 1, 'document_analyses tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folders), 1, 'document_folders tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folder_deletion_plans), 1, 'document_folder_deletion_plans tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_versions), 1, 'document_versions tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_archive_jobs), 1, 'document_archive_jobs tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM notification_jobs), 1, 'notification_jobs tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries), 1, 'agent_journal_entries tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_accounts), 2, 'accounting_accounts tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entries), 1, 'accounting_entries tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entry_lines), 2, 'accounting_entry_lines tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_counters), 1, 'document_counters tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes WHERE id = 'rls-quote-b'), 0, 'tenant A cannot read tenant B quote');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents WHERE id = 'rls-doc-b'), 0, 'tenant A cannot read tenant B document');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_analyses WHERE "documentId" = 'rls-doc-b'), 0, 'tenant A cannot read tenant B document analysis');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folders WHERE id = 'rls-folder-b'), 0, 'tenant A cannot read tenant B folder');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folder_deletion_plans WHERE id = 'rls-folder-plan-b'), 0, 'tenant A cannot read tenant B deletion plan');
SELECT pg_temp.assert_eq((SELECT count(*) FROM notification_jobs WHERE id = '00000000-0000-4000-8000-00000000000b'), 0, 'tenant A cannot read tenant B notification job');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries WHERE id = 'rls-agent-journal-b'), 0, 'tenant A cannot read tenant B agent journal');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entries WHERE id = 'rls-accentry-b'), 0, 'tenant A cannot read tenant B accounting entry');
SELECT pg_temp.assert_eq((SELECT count(*) FROM supplier_memory_profiles WHERE id = 'rls-supplier-b'), 0, 'tenant A cannot read tenant B supplier memory');
SELECT pg_temp.assert_eq((SELECT count(*) FROM subscriptions WHERE id = 'rls-subscription-b'), 0, 'tenant A cannot read tenant B subscription');
SELECT pg_temp.assert_eq((SELECT count(*) FROM fiscal_profiles WHERE id = 'rls-fiscal-profile-b'), 0, 'tenant A cannot read tenant B fiscal profile');

-- Claim/fence sous le rôle runtime : le tenant A peut poser son lease, jamais celui de B,
-- et une génération obsolète ne peut pas finaliser le job.
DO $$
DECLARE affected bigint;
BEGIN
  UPDATE notification_jobs
     SET "leaseToken" = 'lease-generation-a',
         "providerAttemptedAt" = '2026-01-01T00:00:00Z',
         "nextAttemptAt" = '2026-01-01T00:05:00Z',
         "updatedAt" = '2026-01-01T00:00:01Z'
   WHERE id = '00000000-0000-4000-8000-00000000000a' AND "companyId" = 'rls-co-a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'RLS cert failed: tenant A claim expected 1, got %', affected;
  END IF;

  UPDATE notification_jobs
     SET "leaseToken" = 'forbidden-cross-tenant'
   WHERE id = '00000000-0000-4000-8000-00000000000b' AND "companyId" = 'rls-co-b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS cert failed: cross-tenant claim expected 0, got %', affected;
  END IF;

  UPDATE notification_jobs
     SET status = 'done', "leaseToken" = NULL
   WHERE id = '00000000-0000-4000-8000-00000000000a'
     AND "companyId" = 'rls-co-a'
     AND "leaseToken" = 'stale-generation';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS cert failed: stale fence expected 0, got %', affected;
  END IF;
END;
$$;

-- Défense en profondeur du cache : le schéma JSON V1 et l'empreinte de la version source sont
-- certifiés sous le rôle runtime, pas seulement par des tests TypeScript mockés.
INSERT INTO document_versions (
  id, "documentId", version, "storageKey", sha256, "mimeType", "byteSize", "createdAt", reason
)
VALUES (
  'rls-docver-a-validation', 'rls-doc-a', 2,
  'companies/rls-co-a/documents/rls-doc-a/v2/' || repeat('c', 64) || '.jpg',
  repeat('c', 64), 'image/jpeg', 12, '2026-01-01T00:01:00Z', 'rls-validation'
);
DO $$
DECLARE
  valid_analysis jsonb := jsonb_build_object(
    'documentId', 'rls-doc-a', 'documentVersion', 2, 'sourceSha256', repeat('c', 64),
    'type', 'receipt', 'typeConfidence', 0.95, 'summary', 'Analyse de validation.',
    'facts', jsonb_build_array(), 'suggestedTags', jsonb_build_array('receipt'),
    'suggestedFilename', 'receipt-validation', 'suggestedSystemFolder', 'purchases',
    'warnings', jsonb_build_array(), 'requiresHumanReview', true,
    'analyzerVersion', 'rls-cert-v1', 'analyzedAt', '2026-01-01T00:01:00.000Z'
  );
BEGIN
  BEGIN
    INSERT INTO document_analyses (
      "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
      "analysisSchemaVersion", analysis, "analyzedAt"
    ) VALUES (
      'rls-co-a', 'rls-doc-a', 2, repeat('c', 64), 'rls-cert-v1', 2,
      valid_analysis, '2026-01-01T00:01:00.000Z'
    );
    RAISE EXCEPTION 'RLS cert failed: unsupported analysis schema version was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO document_analyses (
      "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
      "analysisSchemaVersion", analysis, "analyzedAt"
    ) VALUES (
      'rls-co-a', 'rls-doc-a', 2, repeat('c', 64), 'rls-cert-v1', 1,
      valid_analysis - 'facts', '2026-01-01T00:01:00.000Z'
    );
    RAISE EXCEPTION 'RLS cert failed: malformed V1 analysis was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO document_analyses (
      "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
      "analysisSchemaVersion", analysis, "analyzedAt"
    ) VALUES (
      'rls-co-a', 'rls-doc-a', 2, repeat('d', 64), 'rls-cert-v1', 1,
      jsonb_set(valid_analysis, '{sourceSha256}', to_jsonb(repeat('d', 64))),
      '2026-01-01T00:01:00.000Z'
    );
    RAISE EXCEPTION 'RLS cert failed: analysis detached from its exact source version was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;
DO $$
BEGIN
  BEGIN
    UPDATE document_analyses
       SET "analyzerVersion" = 'rls-cert-mutated'
     WHERE "documentId" = 'rls-doc-a';
    RAISE EXCEPTION 'RLS cert failed: immutable document analysis update was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM document_analyses WHERE "documentId" = 'rls-doc-a';
    RAISE EXCEPTION 'RLS cert failed: immutable document analysis delete was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO expenses (id, "companyId", "supplierName", "documentDate", "totalTtcCents", category)
    VALUES ('rls-expense-cross', 'rls-co-b', 'Cross Supplier', '2026-01-01', 30000, 'materials');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant expense insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO supplier_memory_profiles (
      id, "companyId", key, "displayName", category, seen, "lastSeenAt", "updatedAt"
    )
    VALUES (
      'rls-supplier-cross', 'rls-co-b', 'cross supplier', 'Cross Supplier', 'materiel', 1,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant supplier memory insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO subscriptions (id, "companyId", plan, status, "createdAt", "updatedAt")
    VALUES ('rls-subscription-cross', 'rls-co-b', 'business', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant subscription insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO fiscal_profiles (
      id, "companyId", "legalForm", "taxRegime", "socialStatus", "activityNature", "vatRegime", "acre",
      "versementLiberatoire", "fiscalYearEnd", "createdAt", "updatedAt"
    )
    VALUES (
      'rls-fiscal-profile-cross', 'rls-co-b', '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
      '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
      '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb, '{"status":"manquant"}'::jsonb,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant fiscal profile insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO document_folder_deletion_plans (
      id, "companyId", "folderId", "expectedRevision", "expectedSnapshot", "createdAt", "expiresAt"
    )
    VALUES (
      'rls-folder-plan-cross', 'rls-co-b', 'rls-folder-b', 1,
      '{"folders":[{"id":"rls-folder-b","parentId":null,"revision":1}],"documents":[]}'::jsonb,
      '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant folder deletion plan insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO documents (
      id, "companyId", kind, origin, status, filename, "mimeType", "byteSize", sha256, "storageKey",
      "documentDate", "createdAt", "retentionUntil"
    )
    VALUES (
      'rls-doc-cross', 'rls-co-b', 'expense_receipt', 'ocr', 'active', 'cross.jpg', 'image/jpeg', 12, repeat('c', 64),
      'companies/rls-co-b/documents/rls-doc-cross/v1/' || repeat('c', 64) || '.jpg',
      '2026-01-01', '2026-01-01T00:00:00Z', '2036-01-01'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant document insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO document_analyses (
      "companyId", "documentId", "documentVersion", "sourceSha256", "analyzerVersion",
      "analysisSchemaVersion", analysis, "analyzedAt"
    )
    VALUES (
      'rls-co-b', 'rls-doc-b', 1, repeat('b', 64), 'rls-cert-cross', 1,
      jsonb_build_object(
        'documentId', 'rls-doc-b', 'documentVersion', 1, 'sourceSha256', repeat('b', 64),
        'type', 'receipt', 'typeConfidence', 0.95, 'summary', 'Analyse cross tenant.',
        'facts', jsonb_build_array(), 'suggestedTags', jsonb_build_array('receipt'),
        'suggestedFilename', 'receipt-cross', 'suggestedSystemFolder', 'purchases',
        'warnings', jsonb_build_array(), 'requiresHumanReview', true,
        'analyzerVersion', 'rls-cert-cross', 'analyzedAt', '2026-01-01T00:00:00.000Z'
      ),
      '2026-01-01T00:00:00.000Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant document analysis insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    IF (
      SELECT "activeVersion" = 1
        FROM public.document_archive_protocol_state
       WHERE id = 1
    ) THEN
      INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
      VALUES ('rls-archive-cross', 'rls-co-b', 'rls-invoice-b', 'invoice-issued-pdf-only-b2c', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    ELSE
      PERFORM public.document_archive_job_enqueue_v2(
        'rls-archive-cross', 'rls-co-b', 'rls-invoice-b', 'invoice-issued-pdf-only-b2c'
      );
    END IF;
    RAISE EXCEPTION 'RLS cert failed: cross-tenant document archive job insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO notification_jobs (
      id, "companyId", kind, "dedupeKey", channel, recipient, subject, payload, "payloadFingerprint",
      status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
    )
    VALUES (
      '00000000-0000-4000-8000-00000000000c', 'rls-co-b', 'quote-signature', 'quote:cross', 'email', 'cross@example.com', 'Cross',
      '{"channel":"email","to":"cross@example.com","subject":"Cross","body":"Cross","idempotencyKey":"00000000-0000-4000-8000-00000000000c"}'::jsonb,
      'cert-cross', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant notification job insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO agent_journal_entries (
      id, "companyId", "runId", seq, at, phase, tool, label, args, mutating, outbound, compliance
    )
    VALUES (
      'rls-agent-journal-cross', 'rls-co-b', 'rls-run-cross', 1, '2026-01-01T00:00:00Z', 'planned',
      'encaisser_facture', 'Cross tenant', '{}'::jsonb, true, false, 'high'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant agent journal insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO accounting_accounts (
      "companyId", code, label, kind, "normalSide", active, "postingAllowed", "updatedAt"
    )
    VALUES ('rls-co-b', '707', 'Cross revenue', 'revenue', 'credit', true, true, '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant accounting account insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO accounting_entries (
      id, "companyId", journal, "sourceType", "sourceId", "entryDate", reference, label
    )
    VALUES ('rls-accentry-cross', 'rls-co-b', 'sales', 'invoice', 'rls-invoice-b', '2026-01-01', 'Cross', 'Cross tenant');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant accounting entry insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO accounting_entry_lines (
      id, "companyId", "entryId", position, account, label, "debitCents", "creditCents"
    )
    VALUES ('rls-accline-cross', 'rls-co-b', 'rls-accentry-b', 3, '411', 'Cross line', 100, 0);
    RAISE EXCEPTION 'RLS cert failed: cross-tenant accounting entry line insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
COMMIT;

-- Les releases gardent l'autorité de capacité fermée pendant leurs autres certifications. Les
-- sondes mutantes Bob Live ne sont exécutées que lorsqu'une capacité éphémère a explicitement été
-- activée ; l'autorité fermée est néanmoins prouvée via son inspector agrégé.
SELECT (mode = 'active') AS bob_live_capacity_active
  FROM inspect_realtime_global_capacity_v1()
\gset
\if :bob_live_capacity_active

-- Bob Live : quotas et bail ne contiennent qu'un subject HMAC/token hashés et restent tenant-scoped.
-- La transaction est annulée pour conserver une certification réexécutable.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'realtime_admission_events', 'realtime_session_leases',
        'realtime_mistral_ingress_tickets', 'realtime_speech_artifacts',
        'realtime_native_speech_deliveries',
        'realtime_control_grants', 'realtime_control_consumptions',
        'realtime_voice_usage_events', 'realtime_voice_usage_daily'
      )
      AND lower(column_name) IN (
        'userid', 'user_id', 'leasetoken', 'reapertoken', 'rendertoken', 'purgetoken',
        'text', 'canonicaltext', 'transcript', 'audio', 'audiobytes'
      )),
  0,
  'realtime durable stores no raw identity, token, speech transcript or audio'
);
INSERT INTO realtime_admission_events (id, "companyId", "subjectHash", "sessionId", "admittedAt")
VALUES (
  '00000000-0000-4000-8000-00000000b0a1', 'rls-co-a', repeat('a', 64),
  '00000000-0000-4000-8000-00000000b0a2', '2026-01-01T00:00:00Z'
);
INSERT INTO realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
  "reservedAt", "leaseExpiresAt", "hardExpiresAt",
  "contextSchemaVersion", "contextRevision", "contextPayload", "contextDigest", "contextUpdatedAt",
  "updatedAt", version
)
VALUES (
  'rls-co-a', repeat('a', 64), '00000000-0000-4000-8000-00000000b0a2', repeat('b', 64), 'reserved',
  CURRENT_TIMESTAMP - INTERVAL '1 second', CURRENT_TIMESTAMP + INTERVAL '15 seconds',
  CURRENT_TIMESTAMP + INTERVAL '15 minutes', 1, 1, '{"screen":{"name":"RLS","instanceId":"rls"},"entities":[],"capabilities":[]}'::jsonb,
  repeat('e', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_reaper_tenant_schedule
    WHERE "companyId" = 'rls-co-a'
      AND "oldestAdmissionAt" IS NOT DISTINCT FROM (
        SELECT min("admittedAt") FROM realtime_admission_events
         WHERE "companyId" = 'rls-co-a'
      )
      AND "nextLeaseDueAt" IS NOT DISTINCT FROM (
        SELECT min(LEAST("leaseExpiresAt", "hardExpiresAt"))
          FROM realtime_session_leases
         WHERE "companyId" = 'rls-co-a' AND state IN ('reserved', 'active', 'reaping')
      )),
  1,
  'realtime schedule tenant A is materialized from its exact source minima'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO realtime_reaper_tenant_schedule (
      "companyId", "oldestAdmissionAt", "nextLeaseDueAt", revision
    ) VALUES (
      'rls-co-b', CURRENT_TIMESTAMP - INTERVAL '1 hour', NULL, 0
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant reaper schedule insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
SET LOCAL app.current_company_id = 'rls-co-b';
INSERT INTO realtime_reaper_tenant_schedule (
  "companyId", "oldestAdmissionAt", "nextLeaseDueAt", revision
) VALUES (
  'rls-co-b', CURRENT_TIMESTAMP - INTERVAL '1 hour',
  CURRENT_TIMESTAMP - INTERVAL '30 minutes', 0
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_reaper_tenant_schedule WHERE "companyId" = 'rls-co-b'),
  1,
  'realtime schedule tenant B can be reconciled in its own context'
);
SET LOCAL app.current_company_id = 'rls-co-a';
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_reaper_tenant_schedule),
  1,
  'tenant A sees only its own realtime schedule after B exists'
);
DO $$
DECLARE
  affected BIGINT;
BEGIN
  UPDATE realtime_reaper_tenant_schedule
     SET revision = revision + 1
   WHERE "companyId" = 'rls-co-b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS cert failed: cross-tenant reaper schedule update affected %', affected;
  END IF;
  DELETE FROM realtime_reaper_tenant_schedule WHERE "companyId" = 'rls-co-b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'RLS cert failed: cross-tenant reaper schedule delete affected %', affected;
  END IF;

  UPDATE realtime_reaper_tenant_schedule
     SET revision = revision + 1
   WHERE "companyId" = 'rls-co-a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'RLS cert failed: own reaper schedule update affected %', affected;
  END IF;
END;
$$;
INSERT INTO realtime_mistral_ingress_tickets (
  id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", "ticketHash", protocol,
  state, plan, "contextSchemaVersion", "contextRevision", "contextDigest",
  "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
  "identityEncryptionKeyVersion", "maxAudioBytes", "issuedAt", "ticketExpiresAt",
  "hardExpiresAt", "retentionExpiresAt", version
)
VALUES (
  '00000000-0000-4000-8000-00000000b0a3', 'rls-co-a', repeat('a', 64), 1,
  '00000000-0000-4000-8000-00000000b0a2', repeat('c', 64), 'bob.mistral-pcm.v1',
  'issued', 'pro', 1, 1, repeat('e', 64), decode('01', 'hex'), decode(repeat('02', 12), 'hex'),
  decode(repeat('03', 16), 'hex'), 1, 32000, CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '10 seconds', CURRENT_TIMESTAMP + INTERVAL '15 minutes',
  CURRENT_TIMESTAMP + INTERVAL '1 day', 1
);
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_admission_events), 1, 'realtime event tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_session_leases), 1, 'realtime lease tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_mistral_ingress_tickets), 1, 'Mistral ticket tenant A visible');
DO $$
BEGIN
  BEGIN
    INSERT INTO realtime_admission_events (id, "companyId", "subjectHash", "sessionId", "admittedAt")
    VALUES (
      '00000000-0000-4000-8000-00000000b0b1', 'rls-co-b', repeat('c', 64),
      '00000000-0000-4000-8000-00000000b0b2', '2026-01-01T00:00:00Z'
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant realtime event insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "reservedAt", "leaseExpiresAt", "hardExpiresAt", "updatedAt", version
    )
    VALUES (
      'rls-co-b', repeat('c', 64), '00000000-0000-4000-8000-00000000b0b2', repeat('d', 64), 'reserved',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:15Z', '2026-01-01T00:15:00Z',
      '2026-01-01T00:00:00Z', 1
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant realtime lease insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
SET LOCAL app.current_company_id = 'rls-co-b';
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_admission_events), 0, 'tenant B cannot see tenant A realtime event');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_session_leases), 0, 'tenant B cannot see tenant A realtime lease');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_mistral_ingress_tickets), 0, 'tenant B cannot see tenant A Mistral ticket');
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_reaper_tenant_schedule WHERE "companyId" = 'rls-co-a'),
  0,
  'tenant B cannot see tenant A realtime schedule after global discovery'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_reaper_tenant_schedule WHERE "companyId" = 'rls-co-b'),
  1,
  'tenant B still sees its own realtime schedule after global discovery'
);
ROLLBACK;

-- Bob Live durable : séquence globale DB, quatrième fence, preuve acoustique sans contenu,
-- contrôle one-shot et rollup d'usage par sujet/plan/kind. Tout est annulé en fin de sonde.
SELECT (
  EXISTS (
    SELECT 1 FROM realtime_mistral_conversation_key_version_floors
     WHERE "keySpace" = 'bob-live-subject-hmac-v1'
       AND 1 BETWEEN "minimumVersion" AND "highestVersion"
  )
  AND EXISTS (
    SELECT 1 FROM realtime_mistral_conversation_key_version_floors
     WHERE "keySpace" = 'openai-native-speech-proof-hmac-v1'
       AND 1 BETWEEN "minimumVersion" AND "highestVersion"
  )
) AS openai_native_key_lifecycle_ready
\gset
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
INSERT INTO realtime_admission_events (id, "companyId", "subjectHash", "sessionId", "admittedAt")
VALUES (
  '00000000-0000-4000-8000-00000000c0a1', 'rls-co-a', repeat('a', 64),
  '00000000-0000-4000-8000-00000000c0a2', CURRENT_TIMESTAMP
);
INSERT INTO realtime_session_leases (
  "companyId", "subjectHash", "sessionId", "leaseTokenHash", state, "providerId", "providerCallId",
  "reservedAt", "leaseExpiresAt", "hardExpiresAt", "activatedAt",
  "contextSchemaVersion", "contextRevision", "contextPayload", "contextDigest", "contextUpdatedAt",
  "sidebandOwnerInstanceHash", "sidebandOwnerTokenHash", "sidebandOwnerLeaseExpiresAt",
  "sidebandOwnerEpoch", "contextAppliedRevision", "contextAppliedDigest", "contextAppliedAt",
  "contextAppliedOwnerEpoch", "sidebandProtocolVersion",
  "updatedAt", version
)
VALUES (
  'rls-co-a', repeat('a', 64), '00000000-0000-4000-8000-00000000c0a2', repeat('f', 64),
  'active', 'openai', 'call_rls_durable_a', CURRENT_TIMESTAMP - INTERVAL '1 minute',
  CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP,
  1, 1, '{"route":"/"}'::jsonb, repeat('4', 64), CURRENT_TIMESTAMP,
  repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 minute', 1,
  1, repeat('4', 64), CURRENT_TIMESTAMP, 1, 2, CURRENT_TIMESTAMP, 1
);
\if :openai_native_key_lifecycle_ready
-- GPT Realtime natif : preuve v2 liée à la politique v1, sans contrôle provider_stream. La
-- politique applicative V1 n'autorise le RTP que pour ces scénarios génériques exacts.
INSERT INTO realtime_native_speech_deliveries (
  "deliveryId", "companyId", "subjectHmac", "subjectKeyVersion", "sessionId", "turnId",
  "contextRevision", "contextDigest", "sidebandOwnerEpoch", "sidebandOwnerTokenHmac",
  "speechPolicyVersion", "speechScenarioId", "canonicalSpeechHmac", "factsHmac",
  "requestNonceHmac", "proofFormatVersion", "proofKeyVersion", provider, model, voice,
  version, revision, phase, "createdAt", "expiresAt", "retentionExpiresAt"
)
VALUES (
  '00000000-0000-4000-8000-00000000c0b3', 'rls-co-a', repeat('a', 64),
  1,
  '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0b4',
  1, repeat('4', 64), 1, repeat('2', 64),
  1, 'generic_help_v1', repeat('5', 64), repeat('7', 64), repeat('e', 64),
  2, 1, 'openai', 'gpt-realtime-2.1', 'cedar',
  1, 1, 'prepared', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '45 seconds',
  CURRENT_TIMESTAMP + INTERVAL '30 days'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO realtime_native_speech_deliveries (
      "deliveryId", "companyId", "subjectHmac", "subjectKeyVersion", "sessionId", "turnId",
      "contextRevision", "contextDigest", "sidebandOwnerEpoch", "sidebandOwnerTokenHmac",
      "speechPolicyVersion", "speechScenarioId", "canonicalSpeechHmac", "factsHmac",
      "requestNonceHmac", "proofFormatVersion", "proofKeyVersion", provider, model, voice,
      version, revision, phase, "createdAt", "expiresAt", "retentionExpiresAt"
    )
    VALUES (
      '00000000-0000-4000-0000-00000000c0b7', 'rls-co-a', repeat('a', 64),
      1,
      '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0b7',
      1, repeat('4', 64), 1, repeat('2', 64),
      1, 'generic_help_v1', repeat('5', 64), repeat('7', 64), repeat('d', 64),
      2, 1, 'openai', 'gpt-realtime-2.1', 'cedar',
      1, 1, 'prepared', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '45 seconds',
      CURRENT_TIMESTAMP + INTERVAL '30 days'
    );
    RAISE EXCEPTION 'RLS cert failed: non-RFC native delivery UUID was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO realtime_native_speech_deliveries (
      "deliveryId", "companyId", "subjectHmac", "subjectKeyVersion", "sessionId", "turnId",
      "contextRevision", "contextDigest", "sidebandOwnerEpoch", "sidebandOwnerTokenHmac",
      "speechPolicyVersion", "speechScenarioId", "canonicalSpeechHmac", "factsHmac",
      "requestNonceHmac", "proofFormatVersion", "proofKeyVersion", provider, model, voice,
      version, revision, phase, "createdAt", "expiresAt", "retentionExpiresAt"
    )
    VALUES (
      '00000000-0000-4000-8000-00000000c0b8', 'rls-co-a', repeat('a', 64),
      1,
      '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0b9',
      1, repeat('4', 64), 1, repeat('2', 64),
      1, 'generic_help_v1', repeat('5', 64), repeat('7', 64), repeat('c', 64),
      2, 1, 'openai', 'gpt-realtime-2.1', 'cedar',
      1, 1, 'prepared', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '45 seconds',
      'infinity'::TIMESTAMPTZ
    );
    RAISE EXCEPTION 'RLS cert failed: infinite native delivery timestamp was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM realtime_native_speech_deliveries),
  1,
  'invalid native UUID and infinity probes leave no row behind'
);
DO $$
BEGIN
  BEGIN
    UPDATE realtime_native_speech_deliveries
       SET phase = 'expired', revision = 2,
           "terminalAt" = "expiresAt"
     WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 1;
    RAISE EXCEPTION 'RLS cert failed: native speech delivery expired before DB deadline';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END;
$$;
SELECT pg_temp.assert_eq(
  (SELECT revision FROM realtime_native_speech_deliveries
    WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3'),
  1,
  'early native expiration is rejected without mutation'
);
UPDATE realtime_native_speech_deliveries
   SET phase = 'dispatching', revision = 2,
       "dispatchClaimId" = '00000000-0000-4000-8000-00000000c0b6',
       "dispatchingAt" = CURRENT_TIMESTAMP
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 1;
UPDATE realtime_native_speech_deliveries
   SET phase = 'requested', revision = 3, "requestedAt" = CURRENT_TIMESTAMP
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 2;
UPDATE realtime_native_speech_deliveries
   SET phase = 'accepted', revision = 4,
       "providerResponseIdHmac" = repeat('b', 64), "acceptedAt" = CURRENT_TIMESTAMP
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 3;
UPDATE realtime_native_speech_deliveries
   SET phase = 'streaming', revision = 5, "streamingAt" = CURRENT_TIMESTAMP
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 4;
UPDATE realtime_native_speech_deliveries
   SET phase = 'draining', revision = 6, "responseDoneAt" = CURRENT_TIMESTAMP,
       "outputTranscriptHmac" = repeat('5', 64)
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 5;
UPDATE realtime_native_speech_deliveries
   SET phase = 'completed', revision = 7, "outputStoppedAt" = CURRENT_TIMESTAMP,
       "completedAt" = CURRENT_TIMESTAMP
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 6;
UPDATE realtime_native_speech_deliveries
   SET phase = 'delivered', revision = 8,
       "acknowledgementId" = '00000000-0000-4000-8000-00000000c0b5',
       "deliveredAt" = CURRENT_TIMESTAMP, "terminalAt" = CURRENT_TIMESTAMP,
       "localObservationFormatVersion" = 1,
       "localObservationKind" = 'webrtc_remote_rtp_observed_provider_drained_v1',
       "sloFormatVersion" = 1, "speechStoppedEventToFirstInboundRtpMs" = 250,
       "bargeInStatus" = 'complete', "bargeInDurationsMs" = ARRAY[120]::INTEGER[]
 WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3' AND revision = 7;
DO $$
BEGIN
  BEGIN
    UPDATE realtime_native_speech_deliveries
       SET revision = 9
     WHERE "deliveryId" = '00000000-0000-4000-8000-00000000c0b3';
    RAISE EXCEPTION 'RLS cert failed: terminal native speech delivery was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END;
$$;
\endif
INSERT INTO realtime_speech_artifacts (
  id, "companyId", "subjectHash", "sessionId", "turnId", "segmentIndex", "renderTokenHash",
  "sidebandOwnerEpoch", "sidebandOwnerTokenHash", state, classification,
  "canonicalSpeechHmac", "factsHmac",
  "contextRevision", "contextDigest", "renderLeaseExpiresAt",
  "createdAt", "updatedAt", "retentionExpiresAt", version
)
VALUES (
  '00000000-0000-4000-8000-00000000c0a3', 'rls-co-a', repeat('a', 64),
  '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0a4',
  0, repeat('3', 64), 1, repeat('2', 64),
  'rendering', 'dynamic_sensitive', repeat('5', 64), repeat('7', 64),
  1, repeat('4', 64),
  CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '30 days', 1
);
SELECT pg_temp.assert_eq(
  (SELECT sequence FROM realtime_speech_artifacts WHERE id = '00000000-0000-4000-8000-00000000c0a3'),
  1,
  'realtime speech sequence allocated globally by lease'
);
UPDATE realtime_speech_artifacts
   SET state = 'ready', source = 'synthesized_audited',
       "storageKey" = 'companies/rls-co-a/bob-live/00000000-0000-4000-8000-00000000c0a2/00000000-0000-4000-8000-00000000c0a4/00000000-0000-4000-8000-00000000c0a3',
       "storageExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '15 minutes',
       "mimeType" = 'audio/mpeg', "byteLength" = 512, "durationMs" = 1000,
       "canonicalSpeechHmac" = repeat('5', 64), "auditTranscriptHmac" = repeat('6', 64),
       "factsHmac" = repeat('7', 64), "evidenceHmac" = repeat('8', 64),
       "audioSha256" = repeat('9', 64), "proofKeyVersion" = 1,
       "synthesisAdapterId" = 'mistral-voxtral-tts', "synthesisTrustDomain" = 'mistral.ai',
       "auditAdapterId" = 'whisper', "auditTrustDomain" = 'openai.com',
       "renderLeaseExpiresAt" = NULL, "readyAt" = CURRENT_TIMESTAMP,
       "updatedAt" = CURRENT_TIMESTAMP, version = 2
 WHERE id = '00000000-0000-4000-8000-00000000c0a3' AND version = 1;
INSERT INTO realtime_control_grants (
  id, "companyId", "sessionId", "turnId", "artifactId", "contextRevision", "contextDigest",
  "controlKind", "sealedControl", "controlNonce", "controlTag", "controlPayloadHmac",
  "encryptionKeyVersion", "proofKeyVersion", "issuedAt", "expiresAt", "retentionExpiresAt"
)
VALUES (
  '00000000-0000-4000-8000-00000000c0a6', 'rls-co-a',
  '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0a4',
  '00000000-0000-4000-8000-00000000c0a3', 1, repeat('4', 64), 'navigate',
  decode(repeat('aa', 32), 'hex'), decode(repeat('bb', 12), 'hex'), decode(repeat('cc', 16), 'hex'),
  repeat('d', 64), 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 seconds',
  CURRENT_TIMESTAMP + INTERVAL '30 days'
);
UPDATE realtime_speech_artifacts
   SET state = 'delivered', "deliveryId" = '00000000-0000-4000-8000-00000000c0a5',
       "storageExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute',
       "deliveredAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP, version = 3
 WHERE id = '00000000-0000-4000-8000-00000000c0a3' AND version = 2;
INSERT INTO realtime_control_consumptions (
  "companyId", "grantId", "acknowledgementId", "sessionId", "turnId", "consumedAt", "retentionExpiresAt"
)
VALUES (
  'rls-co-a', '00000000-0000-4000-8000-00000000c0a6',
  '00000000-0000-4000-8000-00000000c0a5', '00000000-0000-4000-8000-00000000c0a2',
  '00000000-0000-4000-8000-00000000c0a4', CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '30 days'
);
INSERT INTO realtime_voice_usage_events (
  id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", "turnId",
  "dedupeKeyHmac", "proofKeyVersion", plan, kind, source, amount,
  "occurredAt", "recordedAt", "retentionExpiresAt"
)
VALUES (
  '00000000-0000-4000-8000-00000000c0a8', 'rls-co-a', repeat('a', 64), 1,
  '00000000-0000-4000-8000-00000000c0a2', '00000000-0000-4000-8000-00000000c0a4',
  repeat('b', 64), 1, 'pro', 'tts_characters', 'mistral-voxtral-tts', 42.000000,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '35 days'
);
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_speech_artifacts), 1, 'speech artifact tenant A visible');
\if :openai_native_key_lifecycle_ready
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_native_speech_deliveries), 1, 'native speech delivery tenant A visible');
\else
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_native_speech_deliveries), 0, 'native speech remains dormant without staged key lifecycle');
\endif
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_grants), 1, 'control grant tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_consumptions), 1, 'control consumption tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_events), 1, 'voice usage event tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_daily), 1, 'voice usage rollup tenant A visible');
SET LOCAL app.current_company_id = 'rls-co-b';
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_speech_artifacts), 0, 'tenant B cannot see tenant A speech');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_native_speech_deliveries), 0, 'tenant B cannot see tenant A native speech');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_grants), 0, 'tenant B cannot see tenant A control');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_consumptions), 0, 'tenant B cannot see tenant A consumption');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_events), 0, 'tenant B cannot see tenant A usage');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_daily), 0, 'tenant B cannot see tenant A rollup');
ROLLBACK;

\else
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM inspect_realtime_global_capacity_v1() WHERE mode = 'closed'),
  1,
  'closed Bob Live capacity is explicit while lease mutation probes are skipped'
);
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM preflight_realtime_global_capacity_v1('openai', 'closed-cert', 1, 1, 1)
    WHERE status = 'unavailable' AND "retryAt" IS NULL),
  1,
  'closed Bob Live capacity refuses preflight'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO realtime_session_leases (
      "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
      "reservedAt", "leaseExpiresAt", "hardExpiresAt", "updatedAt", version
    ) VALUES (
      'rls-co-a', repeat('9', 64), '00000000-0000-4000-8000-00000000b0f1', repeat('8', 64),
      'reserved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 seconds',
      CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP, 1
    );
    RAISE EXCEPTION 'RLS cert failed: closed capacity accepted a direct lease writer';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$$;
ROLLBACK;
\endif

-- Registre d'idempotence Expense : tenant-scoped, insert-only et sans clé brute. La transaction
-- est volontairement annulée pour que la certification reste réexécutable sans policy DELETE.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
INSERT INTO expense_creation_requests ("companyId", "keyHash", "payloadHash", "expenseId", "createdAt")
VALUES ('rls-co-a', repeat('a', 64), repeat('b', 64), 'rls-expense-a', '2026-01-01T00:00:00Z');
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM expense_creation_requests WHERE "expenseId" = 'rls-expense-a'),
  1,
  'expense creation request tenant A visible'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM expense_creation_requests WHERE "expenseId" = 'rls-expense-b'),
  0,
  'expense creation request tenant B hidden'
);
DO $$
BEGIN
  BEGIN
    UPDATE expense_creation_requests SET "payloadHash" = repeat('c', 64)
     WHERE "companyId" = 'rls-co-a' AND "keyHash" = repeat('a', 64);
    RAISE EXCEPTION 'RLS cert failed: expense idempotency update was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM expense_creation_requests
     WHERE "companyId" = 'rls-co-a' AND "keyHash" = repeat('a', 64);
    RAISE EXCEPTION 'RLS cert failed: expense idempotency delete was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO expense_creation_requests ("companyId", "keyHash", "payloadHash", "expenseId")
    VALUES ('rls-co-b', repeat('c', 64), repeat('d', 64), 'rls-expense-b');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant expense idempotency insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
ROLLBACK;

-- Registre d'idempotence Quote : tenant-scoped, insert-only, sans clé brute et réponse figée.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
INSERT INTO quote_creation_requests (
  "companyId", "keyHash", "payloadHash", "quoteId",
  "totalsHt", "totalsVat", "totalsTtc", "totalsNetToPay", "vatByRate", "createdAt"
)
VALUES (
  'rls-co-a', repeat('e', 64), repeat('f', 64), 'rls-quote-a',
  10000, 2000, 12000, 12000, '{"20":2000}'::jsonb, '2026-01-01T00:00:00Z'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM quote_creation_requests WHERE "quoteId" = 'rls-quote-a'),
  1,
  'quote creation request tenant A visible'
);
DO $$
BEGIN
  BEGIN
    UPDATE quote_creation_requests SET "payloadHash" = repeat('0', 64)
     WHERE "companyId" = 'rls-co-a' AND "keyHash" = repeat('e', 64);
    RAISE EXCEPTION 'RLS cert failed: quote idempotency update was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM quote_creation_requests
     WHERE "companyId" = 'rls-co-a' AND "keyHash" = repeat('e', 64);
    RAISE EXCEPTION 'RLS cert failed: quote idempotency delete was authorized';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
SET LOCAL app.current_company_id = 'rls-co-b';
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM quote_creation_requests WHERE "quoteId" = 'rls-quote-a'),
  0,
  'quote creation request tenant A hidden from tenant B'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO quote_creation_requests (
      "companyId", "keyHash", "payloadHash", "quoteId",
      "totalsHt", "totalsVat", "totalsTtc", "totalsNetToPay", "vatByRate"
    ) VALUES (
      'rls-co-a', repeat('1', 64), repeat('2', 64), 'rls-quote-a',
      10000, 2000, 12000, 12000, '{"20":2000}'::jsonb
    );
    RAISE EXCEPTION 'RLS cert failed: cross-tenant quote idempotency insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
ROLLBACK;

-- Public token lookup can resolve by token hash without tenant context, and only that hash.
BEGIN;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public_access_tokens), 0, 'public token lookup without tenant/hash sees nothing');
SET LOCAL app.public_access_token_hash = 'rls-hash-b';
SELECT pg_temp.assert_eq((SELECT count(*) FROM public_access_tokens WHERE id = 'rls-token-b'), 1, 'public token hash sees matching token');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public_access_tokens WHERE id = 'rls-token-a'), 0, 'public token hash hides other tokens');
COMMIT;

-- Tenant B can see B and cannot see A.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-b';
SELECT pg_temp.assert_eq((SELECT count(*) FROM companies), 1, 'companies tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM customers), 1, 'customers tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes), 1, 'quotes tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM invoices), 1, 'invoices tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM line_items), 1, 'line_items tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM payments), 1, 'payments tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public_access_tokens), 1, 'public_access_tokens tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM expenses), 1, 'expenses tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM supplier_memory_profiles), 1, 'supplier_memory_profiles tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM subscriptions), 1, 'subscriptions tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM fiscal_profiles), 1, 'fiscal_profiles tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents), 1, 'documents tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_analyses), 1, 'document_analyses tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folders), 1, 'document_folders tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folder_deletion_plans), 1, 'document_folder_deletion_plans tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_versions), 1, 'document_versions tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_archive_jobs), 1, 'document_archive_jobs tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM notification_jobs), 1, 'notification_jobs tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries), 1, 'agent_journal_entries tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_accounts), 2, 'accounting_accounts tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entries), 1, 'accounting_entries tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entry_lines), 2, 'accounting_entry_lines tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_counters), 1, 'document_counters tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes WHERE id = 'rls-quote-a'), 0, 'tenant B cannot read tenant A quote');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents WHERE id = 'rls-doc-a'), 0, 'tenant B cannot read tenant A document');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_analyses WHERE "documentId" = 'rls-doc-a'), 0, 'tenant B cannot read tenant A document analysis');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folders WHERE id = 'rls-folder-a'), 0, 'tenant B cannot read tenant A folder');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_folder_deletion_plans WHERE id = 'rls-folder-plan-a'), 0, 'tenant B cannot read tenant A deletion plan');
SELECT pg_temp.assert_eq((SELECT count(*) FROM notification_jobs WHERE id = '00000000-0000-4000-8000-00000000000a'), 0, 'tenant B cannot read tenant A notification job');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries WHERE id = 'rls-agent-journal-a'), 0, 'tenant B cannot read tenant A agent journal');
SELECT pg_temp.assert_eq((SELECT count(*) FROM accounting_entries WHERE id = 'rls-accentry-a'), 0, 'tenant B cannot read tenant A accounting entry');
SELECT pg_temp.assert_eq((SELECT count(*) FROM supplier_memory_profiles WHERE id = 'rls-supplier-a'), 0, 'tenant B cannot read tenant A supplier memory');
SELECT pg_temp.assert_eq((SELECT count(*) FROM subscriptions WHERE id = 'rls-subscription-a'), 0, 'tenant B cannot read tenant A subscription');
SELECT pg_temp.assert_eq((SELECT count(*) FROM fiscal_profiles WHERE id = 'rls-fiscal-profile-a'), 0, 'tenant B cannot read tenant A fiscal profile');
COMMIT;

-- Pendant expand, N-1 peut encore écrire mais le trigger spool empêche toute livraison. Après
-- activation, N-1 ne voit plus rien. Les deux états sont certifiés par le même script.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
SET LOCAL app.notification_outbox_version = '';
SET LOCAL app.notification_outbox_cutover_bypass = '';
DO $$
DECLARE
  affected bigint;
  spooling boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'notification_jobs'::regclass
       AND tgname = 'notification_jobs_cutover_spool_v2'
       AND NOT tgisinternal
  ) INTO spooling;

  IF (SELECT count(*) FROM notification_jobs) <> (CASE WHEN spooling THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'RLS cert failed: unexpected outbox v1 visibility for phase spooling=%', spooling;
  END IF;

  UPDATE notification_jobs SET "lastError" = 'forbidden-v1'
   WHERE id = '00000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> (CASE WHEN spooling THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'RLS cert failed: outbox v1 mutation phase mismatch, got %', affected;
  END IF;
  IF spooling AND NOT EXISTS (
    SELECT 1 FROM notification_jobs
     WHERE id = '00000000-0000-4000-8000-00000000000a'
       AND "nextAttemptAt" = TIMESTAMP '9999-12-31 23:59:59.999'
       AND "leaseToken" IS NULL
  ) THEN
    RAISE EXCEPTION 'RLS cert failed: outbox v1 write was not safely spooled';
  END IF;
END;
$$;
COMMIT;

\ir cabinet-rls-cert.sql

\echo 'RLS certification passed'
