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

-- Runtime cleanup for local reruns. Append-only fixtures are removed by the
-- privileged rls-cert-cleanup.sql invoked before and after this certification.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
DELETE FROM document_folder_deletion_plans WHERE id IN ('rls-folder-plan-a', 'rls-folder-plan-b', 'rls-folder-plan-cross');
DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM supplier_memory_profiles WHERE id IN ('rls-supplier-a', 'rls-supplier-b', 'rls-supplier-cross');
DELETE FROM document_versions WHERE id IN ('rls-docver-a', 'rls-docver-b', 'rls-docver-a-validation');
DELETE FROM documents WHERE id IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
DELETE FROM document_folders WHERE id IN ('rls-folder-a', 'rls-folder-b', 'rls-folder-cross');
DELETE FROM document_archive_jobs WHERE id IN ('rls-archive-a', 'rls-archive-b', 'rls-archive-cross');
DELETE FROM notification_jobs WHERE id IN ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c');
DELETE FROM agent_journal_entries WHERE id IN ('rls-agent-journal-a', 'rls-agent-journal-b', 'rls-agent-journal-cross');
DELETE FROM accounting_entry_lines WHERE id IN ('rls-accline-a-1', 'rls-accline-a-2', 'rls-accline-b-1', 'rls-accline-b-2', 'rls-accline-cross');
DELETE FROM accounting_entries WHERE id IN ('rls-accentry-a', 'rls-accentry-b', 'rls-accentry-cross');
DELETE FROM accounting_accounts WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM document_counters WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM invoices WHERE id IN ('rls-invoice-a', 'rls-invoice-b');
DELETE FROM quotes WHERE id IN ('rls-quote-a', 'rls-quote-b');
DELETE FROM customers WHERE id IN ('rls-customer-a', 'rls-customer-b');
DELETE FROM companies WHERE id IN ('rls-co-a', 'rls-co-b');
COMMIT;

BEGIN;
SET LOCAL app.current_company_id = 'rls-co-b';
DELETE FROM document_folder_deletion_plans WHERE id IN ('rls-folder-plan-a', 'rls-folder-plan-b', 'rls-folder-plan-cross');
DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM supplier_memory_profiles WHERE id IN ('rls-supplier-a', 'rls-supplier-b', 'rls-supplier-cross');
DELETE FROM document_versions WHERE id IN ('rls-docver-a', 'rls-docver-b', 'rls-docver-a-validation');
DELETE FROM documents WHERE id IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
DELETE FROM document_folders WHERE id IN ('rls-folder-a', 'rls-folder-b', 'rls-folder-cross');
DELETE FROM document_archive_jobs WHERE id IN ('rls-archive-a', 'rls-archive-b', 'rls-archive-cross');
DELETE FROM notification_jobs WHERE id IN ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c');
DELETE FROM agent_journal_entries WHERE id IN ('rls-agent-journal-a', 'rls-agent-journal-b', 'rls-agent-journal-cross');
DELETE FROM accounting_entry_lines WHERE id IN ('rls-accline-a-1', 'rls-accline-a-2', 'rls-accline-b-1', 'rls-accline-b-2', 'rls-accline-cross');
DELETE FROM accounting_entries WHERE id IN ('rls-accentry-a', 'rls-accentry-b', 'rls-accentry-cross');
DELETE FROM accounting_accounts WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM document_counters WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM invoices WHERE id IN ('rls-invoice-a', 'rls-invoice-b');
DELETE FROM quotes WHERE id IN ('rls-quote-a', 'rls-quote-b');
DELETE FROM customers WHERE id IN ('rls-customer-a', 'rls-customer-b');
DELETE FROM companies WHERE id IN ('rls-co-a', 'rls-co-b');
COMMIT;

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
INSERT INTO invoices (id, "companyId", "customerId", kind, status)
VALUES ('rls-invoice-a', 'rls-co-a', 'rls-customer-a', 'invoice', 'issued');
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
INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
VALUES ('rls-archive-a', 'rls-co-a', 'rls-invoice-a', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
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
INSERT INTO invoices (id, "companyId", "customerId", kind, status)
VALUES ('rls-invoice-b', 'rls-co-b', 'rls-customer-b', 'invoice', 'issued');
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
INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
VALUES ('rls-archive-b', 'rls-co-b', 'rls-invoice-b', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
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
DELETE FROM document_versions WHERE id = 'rls-docver-a-validation';

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
    INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
    VALUES ('rls-archive-cross', 'rls-co-b', 'rls-invoice-b', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
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
ROLLBACK;

-- Bob Live durable : séquence globale DB, quatrième fence, preuve acoustique sans contenu,
-- contrôle one-shot et rollup d'usage par sujet/plan/kind. Tout est annulé en fin de sonde.
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
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_grants), 1, 'control grant tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_consumptions), 1, 'control consumption tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_events), 1, 'voice usage event tenant A visible');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_daily), 1, 'voice usage rollup tenant A visible');
SET LOCAL app.current_company_id = 'rls-co-b';
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_speech_artifacts), 0, 'tenant B cannot see tenant A speech');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_grants), 0, 'tenant B cannot see tenant A control');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_control_consumptions), 0, 'tenant B cannot see tenant A consumption');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_events), 0, 'tenant B cannot see tenant A usage');
SELECT pg_temp.assert_eq((SELECT count(*) FROM realtime_voice_usage_daily), 0, 'tenant B cannot see tenant A rollup');
ROLLBACK;

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
