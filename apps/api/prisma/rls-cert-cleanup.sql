\set ON_ERROR_STOP on

-- Cleanup des fixtures de certification RLS.
-- Execute via DIRECT_URL privilegiee avant/apres apps/api/prisma/rls-cert.sql,
-- y compris en trap shell si la certification echoue.

BEGIN;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM cabinet_invitation_deliveries WHERE id LIKE 'rls-delivery-%';
DELETE FROM cabinet_audit_events WHERE id LIKE 'rls-audit-%';
DELETE FROM cabinet_invitations WHERE id LIKE 'rls-inv-%';
DELETE FROM cabinet_members WHERE id LIKE 'rls-member-%';
DELETE FROM cabinet_admin_guards WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b');
DELETE FROM cabinets WHERE id IN ('rls-cab-a', 'rls-cab-b');
COMMIT;

DELETE FROM release_flag_subjects WHERE id IN ('rls-flag-user-pilot', 'rls-flag-cab-a', 'rls-flag-cab-b');

DELETE FROM realtime_control_consumptions WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_control_grants WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_native_speech_deliveries WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_speech_artifacts WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_voice_usage_events WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_voice_usage_daily WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_session_leases WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_admission_cancellation_fences
 WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM realtime_admission_events WHERE "companyId" IN ('rls-co-a', 'rls-co-b');
DELETE FROM line_items WHERE id IN ('rls-line-a', 'rls-line-b');
DELETE FROM payments WHERE id IN ('rls-payment-a', 'rls-payment-b');
DELETE FROM public_access_tokens WHERE id IN ('rls-token-a', 'rls-token-b');
DELETE FROM expense_creation_requests WHERE "expenseId" IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM quote_creation_requests WHERE "quoteId" IN ('rls-quote-a', 'rls-quote-b');
DELETE FROM expenses WHERE id IN ('rls-expense-a', 'rls-expense-b', 'rls-expense-cross');
DELETE FROM supplier_memory_profiles WHERE id IN ('rls-supplier-a', 'rls-supplier-b', 'rls-supplier-cross');
DELETE FROM subscriptions WHERE id IN ('rls-subscription-a', 'rls-subscription-b', 'rls-subscription-cross');
DELETE FROM fiscal_profiles WHERE id IN ('rls-fiscal-profile-a', 'rls-fiscal-profile-b', 'rls-fiscal-profile-cross');
DELETE FROM document_folder_deletion_plans WHERE id IN ('rls-folder-plan-a', 'rls-folder-plan-b', 'rls-folder-plan-cross');
DELETE FROM document_analyses WHERE "documentId" IN ('rls-doc-a', 'rls-doc-b', 'rls-doc-cross');
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
