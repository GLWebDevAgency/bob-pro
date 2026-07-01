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

-- Idempotent cleanup for local reruns.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-a';
DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM document_versions WHERE id IN ('rls-docver-a', 'rls-docver-b');
DELETE FROM documents WHERE id IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
DELETE FROM document_archive_jobs WHERE id IN ('rls-archive-a', 'rls-archive-b', 'rls-archive-cross');
DELETE FROM agent_journal_entries WHERE id IN ('rls-agent-journal-a', 'rls-agent-journal-b', 'rls-agent-journal-cross');
DELETE FROM document_counters WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM invoices WHERE id IN ('rls-invoice-a', 'rls-invoice-b');
DELETE FROM quotes WHERE id IN ('rls-quote-a', 'rls-quote-b');
DELETE FROM customers WHERE id IN ('rls-customer-a', 'rls-customer-b');
DELETE FROM companies WHERE id IN ('rls-co-a', 'rls-co-b');
COMMIT;

BEGIN;
SET LOCAL app.current_company_id = 'rls-co-b';
DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM document_versions WHERE id IN ('rls-docver-a', 'rls-docver-b');
DELETE FROM documents WHERE id IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
DELETE FROM document_archive_jobs WHERE id IN ('rls-archive-a', 'rls-archive-b', 'rls-archive-cross');
DELETE FROM agent_journal_entries WHERE id IN ('rls-agent-journal-a', 'rls-agent-journal-b', 'rls-agent-journal-cross');
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
INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
VALUES ('rls-co-a', 'quote', 2026, 2);
INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
VALUES ('rls-archive-a', 'rls-co-a', 'rls-invoice-a', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO agent_journal_entries (
  id, "companyId", "runId", seq, at, phase, tool, label, args, mutating, outbound, compliance, reason, "resultDigest"
)
VALUES (
  'rls-agent-journal-a', 'rls-co-a', 'rls-run-a', 1, '2026-01-01T00:00:00Z', 'planned',
  'encaisser_facture', 'Encaisser F-001', '{"invoiceId":"rls-invoice-a"}'::jsonb, true, false, 'high', NULL, NULL
);
COMMIT;

-- Seed tenant B through RLS WITH CHECK policies.
BEGIN;
SET LOCAL app.current_company_id = 'rls-co-b';
INSERT INTO companies (id, name, "legalForm", siren, siret, trade, "vatRegime", "addrLine1", "addrZip", "addrCity")
VALUES ('rls-co-b', 'RLS Company B', 'EI', '222222222', '22222222200022', 'btp', 'reel_normal', '2 rue B', '69001', 'Lyon');
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
INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
VALUES ('rls-co-b', 'quote', 2026, 2);
INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
VALUES ('rls-archive-b', 'rls-co-b', 'rls-invoice-b', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO agent_journal_entries (
  id, "companyId", "runId", seq, at, phase, tool, label, args, mutating, outbound, compliance, reason, "resultDigest"
)
VALUES (
  'rls-agent-journal-b', 'rls-co-b', 'rls-run-b', 1, '2026-01-01T00:00:00Z', 'planned',
  'encaisser_facture', 'Encaisser F-002', '{"invoiceId":"rls-invoice-b"}'::jsonb, true, false, 'high', NULL, NULL
);
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
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents), 1, 'documents tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_versions), 1, 'document_versions tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_archive_jobs), 1, 'document_archive_jobs tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries), 1, 'agent_journal_entries tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_counters), 1, 'document_counters tenant A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes WHERE id = 'rls-quote-b'), 0, 'tenant A cannot read tenant B quote');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents WHERE id = 'rls-doc-b'), 0, 'tenant A cannot read tenant B document');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries WHERE id = 'rls-agent-journal-b'), 0, 'tenant A cannot read tenant B agent journal');

DO $$
BEGIN
  BEGIN
    INSERT INTO expenses (id, "companyId", "supplierName", "documentDate", "totalTtcCents", category)
    VALUES ('rls-expense-cross', 'rls-co-b', 'Cross Supplier', '2026-01-01', 30000, 'materials');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant expense insert succeeded';
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
    INSERT INTO document_archive_jobs (id, "companyId", "invoiceId", reason, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
    VALUES ('rls-archive-cross', 'rls-co-b', 'rls-invoice-b', 'invoice-issued', 'pending', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'RLS cert failed: cross-tenant document archive job insert succeeded';
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
END;
$$;
COMMIT;

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
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents), 1, 'documents tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_versions), 1, 'document_versions tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_archive_jobs), 1, 'document_archive_jobs tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries), 1, 'agent_journal_entries tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM document_counters), 1, 'document_counters tenant B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM quotes WHERE id = 'rls-quote-a'), 0, 'tenant B cannot read tenant A quote');
SELECT pg_temp.assert_eq((SELECT count(*) FROM documents WHERE id = 'rls-doc-a'), 0, 'tenant B cannot read tenant A document');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agent_journal_entries WHERE id = 'rls-agent-journal-a'), 0, 'tenant B cannot read tenant A agent journal');
COMMIT;

\echo 'RLS certification passed'
