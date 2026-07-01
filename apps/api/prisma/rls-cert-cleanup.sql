\set ON_ERROR_STOP on

-- Cleanup des fixtures de certification RLS.
-- Execute via DIRECT_URL privilegiee avant/apres apps/api/prisma/rls-cert.sql,
-- y compris en trap shell si la certification echoue.

DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM supplier_memory_profiles WHERE id IN ('rls-supplier-a', 'rls-supplier-b', 'rls-supplier-cross');
DELETE FROM document_versions WHERE id IN ('rls-docver-a', 'rls-docver-b');
DELETE FROM documents WHERE id IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
DELETE FROM document_archive_jobs WHERE id IN ('rls-archive-a', 'rls-archive-b', 'rls-archive-cross');
DELETE FROM notification_jobs WHERE id IN ('rls-notification-a', 'rls-notification-b', 'rls-notification-cross');
DELETE FROM agent_journal_entries WHERE id IN ('rls-agent-journal-a', 'rls-agent-journal-b', 'rls-agent-journal-cross');
DELETE FROM accounting_entry_lines WHERE id IN ('rls-accline-a-1', 'rls-accline-a-2', 'rls-accline-b-1', 'rls-accline-b-2', 'rls-accline-cross');
DELETE FROM accounting_entries WHERE id IN ('rls-accentry-a', 'rls-accentry-b', 'rls-accentry-cross');
DELETE FROM accounting_accounts WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM document_counters WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM invoices WHERE id IN ('rls-invoice-a', 'rls-invoice-b');
DELETE FROM quotes WHERE id IN ('rls-quote-a', 'rls-quote-b');
DELETE FROM customers WHERE id IN ('rls-customer-a', 'rls-customer-b');
DELETE FROM companies WHERE id IN ('rls-co-a', 'rls-co-b');
