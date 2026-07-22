-- Bob Live — annuaire durable et équitable du reaper admission.
--
-- La découverte globale ne parcourt jamais l'historique des admissions ni les leases. Une ligne
-- technique par tenant matérialise les deux prochaines échéances. Des triggers statement-level
-- maintiennent cette projection dans la même transaction que les writers N-1 et N.

BEGIN;

CREATE TABLE public.realtime_reaper_tenant_schedule (
  "companyId" TEXT PRIMARY KEY,
  "oldestAdmissionAt" TIMESTAMPTZ,
  "nextLeaseDueAt" TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT realtime_reaper_tenant_schedule_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT realtime_reaper_tenant_schedule_due_check CHECK (
    "oldestAdmissionAt" IS NOT NULL OR "nextLeaseDueAt" IS NOT NULL
  ),
  CONSTRAINT realtime_reaper_tenant_schedule_revision_check CHECK (revision >= 0)
);

CREATE INDEX realtime_reaper_schedule_admission_due_idx
  ON public.realtime_reaper_tenant_schedule ("companyId", "oldestAdmissionAt")
  WHERE "oldestAdmissionAt" IS NOT NULL;
CREATE INDEX realtime_reaper_schedule_lease_due_idx
  ON public.realtime_reaper_tenant_schedule ("companyId", "nextLeaseDueAt")
  WHERE "nextLeaseDueAt" IS NOT NULL;

REVOKE ALL ON TABLE public.realtime_reaper_tenant_schedule FROM PUBLIC;
ALTER TABLE public.realtime_reaper_tenant_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_reaper_tenant_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_reaper_tenant_schedule_authority
  ON public.realtime_reaper_tenant_schedule
  FOR ALL
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

-- Le runtime ne peut réconcilier que la projection du tenant déjà posé par withTenant(). Le rôle
-- global n'obtient jamais d'accès aux tables sources ; il lit uniquement cette projection.
CREATE POLICY realtime_reaper_tenant_schedule_tenant_select
  ON public.realtime_reaper_tenant_schedule
  FOR SELECT
  USING (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
  );
CREATE POLICY realtime_reaper_tenant_schedule_tenant_insert
  ON public.realtime_reaper_tenant_schedule
  FOR INSERT
  WITH CHECK (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
  );
CREATE POLICY realtime_reaper_tenant_schedule_tenant_update
  ON public.realtime_reaper_tenant_schedule
  FOR UPDATE
  USING (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
  )
  WITH CHECK (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
  );
CREATE POLICY realtime_reaper_tenant_schedule_tenant_delete
  ON public.realtime_reaper_tenant_schedule
  FOR DELETE
  USING (
    "companyId" = NULLIF(current_setting('app.current_company_id', TRUE), '')
  );

CREATE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  schedule_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schedule_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.realtime_reaper_tenant_schedule'::regclass;
  IF current_user <> 'bob_realtime_reaper_directory' AND current_user <> schedule_owner THEN
    RAISE EXCEPTION 'realtime reaper schedule authority required' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME NOT IN ('realtime_admission_events', 'realtime_session_leases')
     OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'realtime reaper schedule trigger rejected' USING ERRCODE = '22023';
  END IF;

  -- Une projection de scheduling doit être conservative : les triggers ne déplacent un minimum
  -- que vers le passé. Un UPDATE/DELETE concurrent ne peut donc jamais cacher une échéance réelle.
  -- Le reaper, déjà sérialisé par advisory lock tenant, réconcilie ensuite les deux minima exacts.
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'realtime_admission_events' THEN
    INSERT INTO public.realtime_reaper_tenant_schedule AS schedule (
      "companyId", "oldestAdmissionAt"
    )
    SELECT inserted."companyId", min(inserted."admittedAt")
      FROM new_rows AS inserted
     GROUP BY inserted."companyId"
    ON CONFLICT ("companyId") DO UPDATE
      SET "oldestAdmissionAt" = CASE
            WHEN schedule."oldestAdmissionAt" IS NULL THEN EXCLUDED."oldestAdmissionAt"
            ELSE LEAST(schedule."oldestAdmissionAt", EXCLUDED."oldestAdmissionAt")
          END,
          revision = schedule.revision + 1
      WHERE schedule."oldestAdmissionAt" IS NULL
         OR EXCLUDED."oldestAdmissionAt" < schedule."oldestAdmissionAt";
  ELSE
    INSERT INTO public.realtime_reaper_tenant_schedule AS schedule (
      "companyId", "nextLeaseDueAt"
    )
    SELECT inserted."companyId",
           min(CASE
             WHEN inserted.state = 'reaping' THEN inserted."leaseExpiresAt"
             ELSE LEAST(inserted."leaseExpiresAt", inserted."hardExpiresAt")
           END)
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
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_realtime_reaper_tenant_schedule_v1() FROM PUBLIC;

-- Les six triggers sont créés avant le backfill. Les verrous DDL restent détenus jusqu'au COMMIT :
-- aucune écriture concurrente ne peut se glisser entre le snapshot de reprise et l'activation.
CREATE TRIGGER realtime_admission_event_reaper_schedule_insert
AFTER INSERT ON public.realtime_admission_events
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();
CREATE TRIGGER realtime_admission_event_reaper_schedule_update
AFTER UPDATE ON public.realtime_admission_events
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();
CREATE TRIGGER realtime_admission_event_reaper_schedule_delete
AFTER DELETE ON public.realtime_admission_events
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();

CREATE TRIGGER realtime_session_lease_reaper_schedule_insert
AFTER INSERT ON public.realtime_session_leases
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();
CREATE TRIGGER realtime_session_lease_reaper_schedule_update
AFTER UPDATE ON public.realtime_session_leases
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();
CREATE TRIGGER realtime_session_lease_reaper_schedule_delete
AFTER DELETE ON public.realtime_session_leases
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_reaper_tenant_schedule_v1();

WITH admission AS (
  SELECT event."companyId", min(event."admittedAt") AS "oldestAdmissionAt"
    FROM public.realtime_admission_events AS event
   GROUP BY event."companyId"
), lease AS (
  SELECT session."companyId",
         min(CASE
           WHEN session.state = 'reaping' THEN session."leaseExpiresAt"
           ELSE LEAST(session."leaseExpiresAt", session."hardExpiresAt")
         END) AS "nextLeaseDueAt"
    FROM public.realtime_session_leases AS session
   GROUP BY session."companyId"
), tenant AS (
  SELECT admission."companyId" FROM admission
  UNION
  SELECT lease."companyId" FROM lease
)
INSERT INTO public.realtime_reaper_tenant_schedule (
  "companyId", "oldestAdmissionAt", "nextLeaseDueAt"
)
SELECT tenant."companyId", admission."oldestAdmissionAt", lease."nextLeaseDueAt"
  FROM tenant
  LEFT JOIN admission ON admission."companyId" = tenant."companyId"
  LEFT JOIN lease ON lease."companyId" = tenant."companyId";

CREATE TABLE public.realtime_reaper_directory_cursor (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  "afterAdmissionCompanyId" TEXT,
  "cycleUpperAdmissionCompanyId" TEXT,
  "cycleAdmissionCutoffAt" TIMESTAMPTZ,
  "afterLeaseCompanyId" TEXT,
  "cycleUpperLeaseCompanyId" TEXT,
  "cycleLeaseCutoffAt" TIMESTAMPTZ,
  "preferLease" BOOLEAN NOT NULL DEFAULT TRUE,
  "pendingCompanyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "pendingAfterAdmissionCompanyId" TEXT,
  "pendingAfterLeaseCompanyId" TEXT,
  "pendingAdmissionHasMore" BOOLEAN,
  "pendingLeaseHasMore" BOOLEAN,
  "pendingPreferLease" BOOLEAN,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT realtime_reaper_directory_singleton_check CHECK (singleton),
  CONSTRAINT realtime_reaper_directory_cursor_check CHECK (
    (
      (
        "afterAdmissionCompanyId" IS NULL
        AND "cycleUpperAdmissionCompanyId" IS NULL
        AND "cycleAdmissionCutoffAt" IS NULL
      )
      OR (
        "cycleUpperAdmissionCompanyId" IS NOT NULL
        AND "cycleAdmissionCutoffAt" IS NOT NULL
        AND (
          "afterAdmissionCompanyId" IS NULL
          OR "afterAdmissionCompanyId" <= "cycleUpperAdmissionCompanyId"
        )
      )
    )
    AND (
      (
        "afterLeaseCompanyId" IS NULL
        AND "cycleUpperLeaseCompanyId" IS NULL
        AND "cycleLeaseCutoffAt" IS NULL
      )
      OR (
        "cycleUpperLeaseCompanyId" IS NOT NULL
        AND "cycleLeaseCutoffAt" IS NOT NULL
        AND (
          "afterLeaseCompanyId" IS NULL
          OR "afterLeaseCompanyId" <= "cycleUpperLeaseCompanyId"
        )
      )
    )
  ),
  CONSTRAINT realtime_reaper_directory_claim_check CHECK (
    (
      cardinality("pendingCompanyIds") = 0
      AND "pendingAfterAdmissionCompanyId" IS NULL
      AND "pendingAfterLeaseCompanyId" IS NULL
      AND "pendingAdmissionHasMore" IS NULL AND "pendingLeaseHasMore" IS NULL
      AND "pendingPreferLease" IS NULL
      AND "claimId" IS NULL AND "claimExpiresAt" IS NULL
    )
    OR
    (
      cardinality("pendingCompanyIds") BETWEEN 1 AND 1000
      AND "pendingAdmissionHasMore" IS NOT NULL AND "pendingLeaseHasMore" IS NOT NULL
      AND "pendingPreferLease" IS NOT NULL
      AND "claimId" IS NOT NULL AND "claimExpiresAt" IS NOT NULL
      AND (
        "pendingAfterAdmissionCompanyId" IS NULL
        OR (
          "cycleUpperAdmissionCompanyId" IS NOT NULL
          AND "pendingAfterAdmissionCompanyId" <= "cycleUpperAdmissionCompanyId"
        )
      )
      AND (
        "pendingAfterLeaseCompanyId" IS NULL
        OR (
          "cycleUpperLeaseCompanyId" IS NOT NULL
          AND "pendingAfterLeaseCompanyId" <= "cycleUpperLeaseCompanyId"
        )
      )
    )
  ),
  CONSTRAINT realtime_reaper_directory_revision_check CHECK (revision >= 0)
);

INSERT INTO public.realtime_reaper_directory_cursor(singleton) VALUES (TRUE);

REVOKE ALL ON TABLE public.realtime_reaper_directory_cursor FROM PUBLIC;
ALTER TABLE public.realtime_reaper_directory_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_reaper_directory_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_reaper_directory_cursor_select
  ON public.realtime_reaper_directory_cursor
  FOR SELECT
  USING (current_user = 'bob_realtime_reaper_directory');
CREATE POLICY realtime_reaper_directory_cursor_update
  ON public.realtime_reaper_directory_cursor
  FOR UPDATE
  USING (current_user = 'bob_realtime_reaper_directory')
  WITH CHECK (current_user = 'bob_realtime_reaper_directory');

CREATE FUNCTION public.list_realtime_reaper_tenants_v1(
  batch_limit INTEGER,
  claim_id UUID
)
RETURNS TABLE ("companyId" TEXT, "hasMore" BOOLEAN, "claimId" UUID)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  observed_at TIMESTAMPTZ;
  admission_after TEXT;
  admission_upper TEXT;
  admission_cutoff TIMESTAMPTZ;
  lease_after TEXT;
  lease_upper TEXT;
  lease_cutoff TIMESTAMPTZ;
  prefer_lease BOOLEAN;
  pending_company_ids TEXT[];
  pending_admission_after TEXT;
  pending_lease_after TEXT;
  pending_admission_has_more BOOLEAN;
  pending_lease_has_more BOOLEAN;
  pending_prefer_lease BOOLEAN;
  active_claim_id UUID;
  active_claim_expires_at TIMESTAMPTZ;
  scanned_lease_company_ids TEXT[];
  selected_lease_company_ids TEXT[];
  scanned_admission_company_ids TEXT[];
  selected_admission_company_ids TEXT[];
  claimed_company_ids TEXT[];
  desired_lease_count INTEGER;
  desired_admission_count INTEGER;
  remaining_capacity INTEGER;
  lease_scanned_count INTEGER := 0;
  lease_selected_count INTEGER := 0;
  admission_scanned_count INTEGER := 0;
  admission_selected_count INTEGER := 0;
  lease_has_more BOOLEAN := FALSE;
  admission_has_more BOOLEAN := FALSE;
BEGIN
  IF current_user <> 'bob_realtime_reaper_directory' THEN
    RAISE EXCEPTION 'realtime reaper directory authority required' USING ERRCODE = '42501';
  END IF;
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 OR claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime reaper directory claim rejected' USING ERRCODE = '22023';
  END IF;

  SELECT cursor."afterAdmissionCompanyId", cursor."cycleUpperAdmissionCompanyId",
         cursor."cycleAdmissionCutoffAt", cursor."afterLeaseCompanyId",
         cursor."cycleUpperLeaseCompanyId", cursor."cycleLeaseCutoffAt", cursor."preferLease",
         cursor."pendingCompanyIds", cursor."pendingAfterAdmissionCompanyId",
         cursor."pendingAfterLeaseCompanyId", cursor."pendingAdmissionHasMore",
         cursor."pendingLeaseHasMore", cursor."pendingPreferLease",
         cursor."claimId", cursor."claimExpiresAt"
    INTO STRICT admission_after, admission_upper, admission_cutoff,
                lease_after, lease_upper, lease_cutoff, prefer_lease,
                pending_company_ids, pending_admission_after, pending_lease_after,
                pending_admission_has_more, pending_lease_has_more, pending_prefer_lease,
                active_claim_id, active_claim_expires_at
    FROM public.realtime_reaper_directory_cursor AS cursor
   WHERE cursor.singleton
   FOR UPDATE;
  observed_at := clock_timestamp();

  IF active_claim_id IS NOT NULL THEN
    IF active_claim_expires_at > observed_at THEN
      RETURN;
    END IF;
    UPDATE public.realtime_reaper_directory_cursor AS cursor
       SET "claimId" = claim_id,
           "claimExpiresAt" = observed_at + INTERVAL '30 seconds',
           revision = cursor.revision + 1
     WHERE cursor.singleton;
    RETURN QUERY
      SELECT pending_company_ids[position],
             pending_admission_has_more OR pending_lease_has_more,
             claim_id
        FROM generate_subscripts(pending_company_ids, 1) AS position
       ORDER BY position;
    RETURN;
  END IF;

  IF admission_upper IS NULL THEN
    admission_cutoff := observed_at - INTERVAL '2 hours';
    SELECT schedule."companyId"
      INTO admission_upper
      FROM public.realtime_reaper_tenant_schedule AS schedule
     WHERE schedule."oldestAdmissionAt" <= admission_cutoff
     ORDER BY schedule."companyId" DESC
     LIMIT 1;
    IF admission_upper IS NULL THEN
      admission_cutoff := NULL;
    END IF;
  END IF;
  IF lease_upper IS NULL THEN
    lease_cutoff := observed_at;
    SELECT schedule."companyId"
      INTO lease_upper
      FROM public.realtime_reaper_tenant_schedule AS schedule
     WHERE schedule."nextLeaseDueAt" <= lease_cutoff
     ORDER BY schedule."companyId" DESC
     LIMIT 1;
    IF lease_upper IS NULL THEN
      lease_cutoff := NULL;
    END IF;
  END IF;

  -- Chaque lane matérialise au plus batch+1 lignes d'annuaire, donc indépendamment du nombre
  -- d'événements ou de leases d'un tenant. Les candidats lease sont exclus de l'autre lane.
  IF lease_upper IS NOT NULL THEN
    SELECT array_agg(candidate."companyId" ORDER BY candidate."companyId")
      INTO scanned_lease_company_ids
      FROM (
        SELECT schedule."companyId"
          FROM public.realtime_reaper_tenant_schedule AS schedule
         WHERE schedule."nextLeaseDueAt" <= lease_cutoff
           AND (lease_after IS NULL OR schedule."companyId" > lease_after)
           AND schedule."companyId" <= lease_upper
         ORDER BY schedule."companyId"
         LIMIT batch_limit + 1
      ) AS candidate;
  END IF;
  lease_scanned_count := COALESCE(cardinality(scanned_lease_company_ids), 0);

  IF admission_upper IS NOT NULL THEN
    SELECT array_agg(candidate."companyId" ORDER BY candidate."companyId")
      INTO scanned_admission_company_ids
      FROM (
        SELECT schedule."companyId"
          FROM public.realtime_reaper_tenant_schedule AS schedule
         WHERE schedule."oldestAdmissionAt" <= admission_cutoff
           AND (admission_after IS NULL OR schedule."companyId" > admission_after)
           AND schedule."companyId" <= admission_upper
           AND (
             scanned_lease_company_ids IS NULL
             OR NOT schedule."companyId" = ANY(scanned_lease_company_ids)
           )
         ORDER BY schedule."companyId"
         LIMIT batch_limit + 1
      ) AS candidate;
  END IF;
  admission_scanned_count := COALESCE(cardinality(scanned_admission_company_ids), 0);

  desired_lease_count := batch_limit / 2;
  desired_admission_count := batch_limit / 2;
  IF batch_limit % 2 = 1 THEN
    IF prefer_lease THEN
      desired_lease_count := desired_lease_count + 1;
    ELSE
      desired_admission_count := desired_admission_count + 1;
    END IF;
  END IF;

  lease_selected_count := LEAST(lease_scanned_count, desired_lease_count);
  desired_admission_count := desired_admission_count
    + (desired_lease_count - lease_selected_count);
  admission_selected_count := LEAST(admission_scanned_count, desired_admission_count);

  remaining_capacity := batch_limit - lease_selected_count - admission_selected_count;
  lease_selected_count := LEAST(
    lease_scanned_count,
    lease_selected_count + remaining_capacity
  );
  remaining_capacity := batch_limit - lease_selected_count - admission_selected_count;
  admission_selected_count := LEAST(
    admission_scanned_count,
    admission_selected_count + remaining_capacity
  );

  lease_has_more := lease_scanned_count > lease_selected_count;
  admission_has_more := admission_scanned_count > admission_selected_count;
  IF lease_selected_count > 0 THEN
    selected_lease_company_ids := scanned_lease_company_ids[1:lease_selected_count];
  END IF;
  IF admission_selected_count > 0 THEN
    selected_admission_company_ids := scanned_admission_company_ids[1:admission_selected_count];
  END IF;

  claimed_company_ids := COALESCE(selected_lease_company_ids, ARRAY[]::TEXT[])
    || COALESCE(selected_admission_company_ids, ARRAY[]::TEXT[]);
  IF cardinality(claimed_company_ids) = 0 THEN
    UPDATE public.realtime_reaper_directory_cursor AS cursor
       SET "afterAdmissionCompanyId" = NULL, "cycleUpperAdmissionCompanyId" = NULL,
           "cycleAdmissionCutoffAt" = NULL,
           "afterLeaseCompanyId" = NULL, "cycleUpperLeaseCompanyId" = NULL,
           "cycleLeaseCutoffAt" = NULL,
           revision = cursor.revision + 1
     WHERE cursor.singleton;
    RETURN;
  END IF;

  UPDATE public.realtime_reaper_directory_cursor AS cursor
     SET "cycleUpperAdmissionCompanyId" = admission_upper,
         "cycleAdmissionCutoffAt" = admission_cutoff,
         "cycleUpperLeaseCompanyId" = lease_upper,
         "cycleLeaseCutoffAt" = lease_cutoff,
         "pendingCompanyIds" = claimed_company_ids,
         "pendingAfterAdmissionCompanyId" = CASE
           WHEN admission_selected_count > 0
             THEN selected_admission_company_ids[admission_selected_count]
           ELSE NULL
         END,
         "pendingAfterLeaseCompanyId" = CASE
           WHEN lease_selected_count > 0 THEN selected_lease_company_ids[lease_selected_count]
           ELSE NULL
         END,
         "pendingAdmissionHasMore" = admission_has_more,
         "pendingLeaseHasMore" = lease_has_more,
         "pendingPreferLease" = CASE
           WHEN lease_scanned_count > 0 AND admission_scanned_count > 0
             THEN NOT prefer_lease
           ELSE prefer_lease
         END,
         "claimId" = claim_id,
         "claimExpiresAt" = observed_at + INTERVAL '30 seconds',
         revision = cursor.revision + 1
   WHERE cursor.singleton;

  RETURN QUERY
    SELECT claimed_company_ids[position], admission_has_more OR lease_has_more, claim_id
      FROM generate_subscripts(claimed_company_ids, 1) AS position
     ORDER BY position;
END;
$$;

REVOKE ALL ON FUNCTION public.list_realtime_reaper_tenants_v1(INTEGER, UUID) FROM PUBLIC;

CREATE FUNCTION public.ack_realtime_reaper_tenants_v1(claim_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  observed_at TIMESTAMPTZ := clock_timestamp();
  admission_has_more BOOLEAN;
  lease_has_more BOOLEAN;
  admission_pending_after TEXT;
  lease_pending_after TEXT;
  next_prefer_lease BOOLEAN;
BEGIN
  IF current_user <> 'bob_realtime_reaper_directory' THEN
    RAISE EXCEPTION 'realtime reaper directory authority required' USING ERRCODE = '42501';
  END IF;
  IF claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime reaper directory acknowledgement rejected' USING ERRCODE = '22023';
  END IF;

  SELECT cursor."pendingAdmissionHasMore", cursor."pendingLeaseHasMore",
         cursor."pendingAfterAdmissionCompanyId", cursor."pendingAfterLeaseCompanyId",
         cursor."pendingPreferLease"
    INTO admission_has_more, lease_has_more, admission_pending_after, lease_pending_after,
         next_prefer_lease
    FROM public.realtime_reaper_directory_cursor AS cursor
   WHERE cursor.singleton AND cursor."claimId" = claim_id
     AND cursor."claimExpiresAt" > observed_at
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.realtime_reaper_directory_cursor AS cursor
     SET "afterAdmissionCompanyId" = CASE
           WHEN admission_has_more
             THEN COALESCE(admission_pending_after, cursor."afterAdmissionCompanyId")
           ELSE NULL
         END,
         "cycleUpperAdmissionCompanyId" = CASE
           WHEN admission_has_more THEN cursor."cycleUpperAdmissionCompanyId" ELSE NULL
         END,
         "cycleAdmissionCutoffAt" = CASE
           WHEN admission_has_more THEN cursor."cycleAdmissionCutoffAt" ELSE NULL
         END,
         "afterLeaseCompanyId" = CASE
           WHEN lease_has_more THEN COALESCE(lease_pending_after, cursor."afterLeaseCompanyId")
           ELSE NULL
         END,
         "cycleUpperLeaseCompanyId" = CASE
           WHEN lease_has_more THEN cursor."cycleUpperLeaseCompanyId" ELSE NULL
         END,
         "cycleLeaseCutoffAt" = CASE
           WHEN lease_has_more THEN cursor."cycleLeaseCutoffAt" ELSE NULL
         END,
         "preferLease" = next_prefer_lease,
         "pendingCompanyIds" = ARRAY[]::TEXT[],
         "pendingAfterAdmissionCompanyId" = NULL,
         "pendingAfterLeaseCompanyId" = NULL,
         "pendingAdmissionHasMore" = NULL, "pendingLeaseHasMore" = NULL,
         "pendingPreferLease" = NULL,
         "claimId" = NULL, "claimExpiresAt" = NULL,
         revision = cursor.revision + 1
   WHERE cursor.singleton AND cursor."claimId" = claim_id
     AND cursor."claimExpiresAt" > clock_timestamp();
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.ack_realtime_reaper_tenants_v1(UUID) FROM PUBLIC;

CREATE FUNCTION public.renew_realtime_reaper_tenants_claim_v1(claim_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF current_user <> 'bob_realtime_reaper_directory' THEN
    RAISE EXCEPTION 'realtime reaper directory authority required' USING ERRCODE = '42501';
  END IF;
  IF claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime reaper directory renewal rejected' USING ERRCODE = '22023';
  END IF;

  UPDATE public.realtime_reaper_directory_cursor AS cursor
     SET "claimExpiresAt" = observed_at + INTERVAL '30 seconds',
         revision = cursor.revision + 1
   WHERE cursor.singleton AND cursor."claimId" = claim_id
     AND cursor."claimExpiresAt" > observed_at;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_realtime_reaper_tenants_claim_v1(UUID) FROM PUBLIC;

COMMIT;
