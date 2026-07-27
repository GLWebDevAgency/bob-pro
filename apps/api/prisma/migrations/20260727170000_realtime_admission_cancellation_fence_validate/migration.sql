-- Bob Live — validation séparée du fence d'annulation expand-only.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- PostgreSQL refuse une validation globale sous FORCE RLS pour un owner non-superuser. La fenêtre
-- reste atomique : tout échec rollbacke aussi NO FORCE, et aucune autre session n'observe cet état.
ALTER TABLE public.companies
  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_admission_cancellation_fences
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.realtime_admission_cancellation_fences
  VALIDATE CONSTRAINT realtime_admission_cancellation_fences_company_fkey;

ALTER TABLE public.realtime_admission_cancellation_fences
  VALIDATE CONSTRAINT realtime_admission_cancellation_fences_shape_check;

ALTER TABLE public.realtime_admission_cancellation_fences
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companies
  FORCE ROW LEVEL SECURITY;

COMMIT;
