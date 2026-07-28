-- Bob Live — fence durable d'une annulation reçue avant ou pendant le bootstrap.
-- Une ligne par hash courant/historique protège aussi le writer N-1 via le trigger de lease.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE TABLE public.realtime_admission_cancellation_fences (
  "companyId" TEXT NOT NULL,
  "sessionId" UUID NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "cancelledAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT realtime_admission_cancellation_fence_pkey
    PRIMARY KEY ("companyId", "sessionId", "subjectHash")
);

ALTER TABLE public.realtime_admission_cancellation_fences
  ADD CONSTRAINT realtime_admission_cancellation_fences_company_fkey
  FOREIGN KEY ("companyId") REFERENCES public.companies(id)
  ON UPDATE CASCADE ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.realtime_admission_cancellation_fences
  ADD CONSTRAINT realtime_admission_cancellation_fences_shape_check
  CHECK (
    "subjectHash" ~ '^[a-f0-9]{64}$'
    AND pg_catalog.isfinite("cancelledAt")
    AND pg_catalog.isfinite("expiresAt")
    AND "expiresAt" = "cancelledAt" + INTERVAL '2 hours'
  )
  NOT VALID;

CREATE INDEX realtime_admission_cancellation_fences_tenant_expiry_idx
  ON public.realtime_admission_cancellation_fences (
    "companyId", "expiresAt", "sessionId", "subjectHash"
  );

REVOKE ALL PRIVILEGES
  ON TABLE public.realtime_admission_cancellation_fences
  FROM PUBLIC;
ALTER TABLE public.realtime_admission_cancellation_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_admission_cancellation_fences FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_admission_cancellation_fence_tenant_isolation
  ON public.realtime_admission_cancellation_fences
  FOR ALL
  USING (
    "companyId" = NULLIF(pg_catalog.current_setting('app.current_company_id', TRUE), '')
  )
  WITH CHECK (
    "companyId" = NULLIF(pg_catalog.current_setting('app.current_company_id', TRUE), '')
  );

-- Le trigger est SECURITY INVOKER : la policy tenant de la table fence reste l'autorité. Un
-- writer N-1 qui ignore cette table ne peut donc pas recréer un handle déjà annulé.
CREATE FUNCTION public.guard_realtime_admission_cancellation_fence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
AS $realtime_admission_cancellation_fence_guard$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME <> 'realtime_session_leases'
     OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'realtime admission cancellation trigger rejected'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.realtime_admission_cancellation_fences AS fence
     WHERE fence."companyId" = NEW."companyId"
       AND fence."sessionId" = NEW."sessionId"
       AND fence."subjectHash" = NEW."subjectHash"
       AND fence."expiresAt" > pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'realtime admission session cancelled'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$realtime_admission_cancellation_fence_guard$;

REVOKE ALL
  ON FUNCTION public.guard_realtime_admission_cancellation_fence_v1()
  FROM PUBLIC;

CREATE TRIGGER realtime_session_lease_00_admission_cancellation_fence_guard
BEFORE INSERT ON public.realtime_session_leases
FOR EACH ROW
EXECUTE FUNCTION public.guard_realtime_admission_cancellation_fence_v1();

-- L'annuaire global ne lit jamais la source tenantée. Ce trigger invoker ne fait qu'abaisser la
-- prochaine échéance du tenant ; le reaper la réconcilie ensuite exactement sous son verrou.
CREATE FUNCTION public.sync_realtime_admission_cancellation_schedule_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $realtime_admission_cancellation_schedule$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME <> 'realtime_admission_cancellation_fences'
     OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'realtime admission cancellation schedule trigger rejected'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.realtime_reaper_tenant_schedule AS schedule (
    "companyId", "nextLeaseDueAt"
  )
  SELECT inserted."companyId", min(inserted."expiresAt")
    FROM new_rows AS inserted
   GROUP BY inserted."companyId"
  ON CONFLICT ("companyId") DO UPDATE
    SET "nextLeaseDueAt" = CASE
          WHEN schedule."nextLeaseDueAt" IS NULL THEN EXCLUDED."nextLeaseDueAt"
          ELSE LEAST(schedule."nextLeaseDueAt", EXCLUDED."nextLeaseDueAt")
        END,
        revision = schedule.revision + 1
    WHERE schedule."nextLeaseDueAt" IS NULL
       OR EXCLUDED."nextLeaseDueAt" < schedule."nextLeaseDueAt";
  RETURN NULL;
END;
$realtime_admission_cancellation_schedule$;

REVOKE ALL
  ON FUNCTION public.sync_realtime_admission_cancellation_schedule_v1()
  FROM PUBLIC;

CREATE TRIGGER realtime_admission_cancellation_reaper_schedule_insert
AFTER INSERT ON public.realtime_admission_cancellation_fences
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_realtime_admission_cancellation_schedule_v1();

-- Supabase accorde souvent les tables/fonctions du schéma public à ses rôles Data API.
DO $realtime_admission_cancellation_data_api_fence$
DECLARE
  exposed_role TEXT;
  column_name TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_admission_cancellation_fences FROM %I',
        exposed_role
      );
      FOR column_name IN
        SELECT attribute.attname
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid =
               'public.realtime_admission_cancellation_fences'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attacl IS NOT NULL
         ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.realtime_admission_cancellation_fences FROM %I',
          column_name,
          column_name,
          column_name,
          column_name,
          exposed_role
        );
      END LOOP;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.guard_realtime_admission_cancellation_fence_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.sync_realtime_admission_cancellation_schedule_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$realtime_admission_cancellation_data_api_fence$;

COMMIT;
