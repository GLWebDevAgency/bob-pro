-- Jarvis U1-l — annuaire de dispatch v2 paginé, loué et fencé.
--
-- Expand strictement additif : la fonction v1 et la forme de `jarvis_work_items` restent
-- inchangées pour N-1. Le binaire N utilisera exclusivement les quatre gestes v2 après le
-- provisionnement propriétaire. La migration crée les fonctions SECURITY INVOKER et leur retire
-- tout EXECUTE public : avant provisionnement, elles refusent donc fermement tout appel.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- La table, son index et ses policies doivent appartenir au même owner que `jarvis_work_items`.
-- Ce point est requis par le rituel Supabase non-superuser et par le contrôle mono-owner de
-- `rls.sql`. Les fonctions naissent ensuite sous le deployer afin de pouvoir être transférées à
-- l'autorité dédiée par `release.sh`.
DO $bob_jarvis_u1l_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'jarvis_work_items'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1L_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1L_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1l_owner$;

CREATE TABLE public.jarvis_dispatch_directory_cursors (
  "companyId" TEXT PRIMARY KEY
    REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "afterOwnerUserId" TEXT COLLATE "C",
  "afterRunId" UUID,
  "cycleUpperOwnerUserId" TEXT COLLATE "C",
  "cycleUpperRunId" UUID,
  "cycleCutoffAt" TIMESTAMPTZ,
  "pendingOwnerUserIds" TEXT[] COLLATE "C" NOT NULL DEFAULT ARRAY[]::TEXT[],
  "pendingRunIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "pendingAfterOwnerUserId" TEXT COLLATE "C",
  "pendingAfterRunId" UUID,
  "pendingHasMore" BOOLEAN,
  "pendingNextPosition" INTEGER,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMPTZ,
  "claimHardExpiresAt" TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT jarvis_dispatch_directory_cursors_arrays_check CHECK (
    cardinality("pendingOwnerUserIds") = cardinality("pendingRunIds")
    AND cardinality("pendingOwnerUserIds") BETWEEN 0 AND 50
    AND (
      cardinality("pendingOwnerUserIds") = 0
      OR (
        array_ndims("pendingOwnerUserIds") = 1
        AND array_ndims("pendingRunIds") = 1
        AND array_lower("pendingOwnerUserIds", 1) = 1
        AND array_lower("pendingRunIds", 1) = 1
        AND array_dims("pendingOwnerUserIds") = array_dims("pendingRunIds")
        AND array_position("pendingOwnerUserIds", NULL) IS NULL
        AND array_position("pendingRunIds", NULL) IS NULL
      )
    )
  ),
  CONSTRAINT jarvis_dispatch_directory_cursors_tuples_check CHECK (
    (
      ("afterOwnerUserId" IS NULL AND "afterRunId" IS NULL)
      OR ("afterOwnerUserId" IS NOT NULL AND "afterRunId" IS NOT NULL)
    )
    AND (
      (
        "cycleUpperOwnerUserId" IS NULL
        AND "cycleUpperRunId" IS NULL
        AND "cycleCutoffAt" IS NULL
      )
      OR (
        "cycleUpperOwnerUserId" IS NOT NULL
        AND "cycleUpperRunId" IS NOT NULL
        AND "cycleCutoffAt" IS NOT NULL
        AND pg_catalog.isfinite("cycleCutoffAt")
      )
    )
    AND (
      ("pendingAfterOwnerUserId" IS NULL AND "pendingAfterRunId" IS NULL)
      OR ("pendingAfterOwnerUserId" IS NOT NULL AND "pendingAfterRunId" IS NOT NULL)
    )
    AND ("afterOwnerUserId" IS NULL OR "cycleUpperOwnerUserId" IS NOT NULL)
    AND ("pendingAfterOwnerUserId" IS NULL OR "cycleUpperOwnerUserId" IS NOT NULL)
    AND (
      "cycleUpperOwnerUserId" IS NULL
      OR "afterOwnerUserId" IS NOT NULL
      OR cardinality("pendingOwnerUserIds") > 0
    )
    AND (
      "afterOwnerUserId" IS NULL
      OR (
        ROW("afterOwnerUserId" COLLATE "C", "afterRunId")
          < ROW("cycleUpperOwnerUserId" COLLATE "C", "cycleUpperRunId")
      ) IS TRUE
    )
    AND (
      "pendingAfterOwnerUserId" IS NULL
      OR (
        ROW("pendingAfterOwnerUserId" COLLATE "C", "pendingAfterRunId")
          <= ROW("cycleUpperOwnerUserId" COLLATE "C", "cycleUpperRunId")
      ) IS TRUE
    )
    AND (
      "afterOwnerUserId" IS NULL
      OR "pendingAfterOwnerUserId" IS NULL
      OR (
        ROW("afterOwnerUserId" COLLATE "C", "afterRunId")
          < ROW("pendingAfterOwnerUserId" COLLATE "C", "pendingAfterRunId")
      ) IS TRUE
    )
  ),
  CONSTRAINT jarvis_dispatch_directory_cursors_pending_check CHECK (
    (
      cardinality("pendingOwnerUserIds") = 0
      AND "pendingAfterOwnerUserId" IS NULL
      AND "pendingAfterRunId" IS NULL
      AND "pendingHasMore" IS NULL
      AND "pendingNextPosition" IS NULL
      AND "claimId" IS NULL
      AND "claimExpiresAt" IS NULL
      AND "claimHardExpiresAt" IS NULL
    )
    OR (
      cardinality("pendingOwnerUserIds") BETWEEN 1 AND 50
      AND "pendingAfterOwnerUserId" IS NOT NULL
      AND "pendingAfterRunId" IS NOT NULL
      AND "pendingHasMore" IS NOT NULL
      AND "pendingNextPosition" IS NOT NULL
      AND "pendingNextPosition" BETWEEN 1 AND cardinality("pendingOwnerUserIds") + 1
      AND "claimId" IS NOT NULL
      AND "claimId" <> '00000000-0000-0000-0000-000000000000'::UUID
      AND "claimExpiresAt" IS NOT NULL
      AND pg_catalog.isfinite("claimExpiresAt")
      AND "claimHardExpiresAt" IS NOT NULL
      AND pg_catalog.isfinite("claimHardExpiresAt")
      AND "claimExpiresAt" <= "claimHardExpiresAt"
      AND (
        "pendingOwnerUserIds"[cardinality("pendingOwnerUserIds")]
          IS NOT DISTINCT FROM "pendingAfterOwnerUserId"
      )
      AND (
        "pendingRunIds"[cardinality("pendingRunIds")]
          IS NOT DISTINCT FROM "pendingAfterRunId"
      )
      AND (
        NOT "pendingHasMore"
        OR (
          ROW("pendingAfterOwnerUserId" COLLATE "C", "pendingAfterRunId")
            < ROW("cycleUpperOwnerUserId" COLLATE "C", "cycleUpperRunId")
        ) IS TRUE
      )
    )
  ),
  CONSTRAINT jarvis_dispatch_directory_cursors_revision_check CHECK (revision >= 0)
);

CREATE INDEX jarvis_work_items_dispatch_directory_keyset_idx
  ON public.jarvis_work_items (
    "companyId",
    "ownerUserId" COLLATE "C",
    "runId"
  )
  WHERE (
    "status" IN ('prepared', 'retry_due')
    OR ("status" = 'leased' AND "leaseExpiresAt" IS NOT NULL)
    OR (
      "status" = 'authorized'
      AND "leaseExpiresAt" IS NOT NULL
      AND "resultDigest" IS NULL
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
  );

DROP POLICY IF EXISTS jarvis_work_items_dispatch_directory_select
  ON public.jarvis_work_items;

CREATE POLICY jarvis_work_items_dispatch_directory_select
  ON public.jarvis_work_items FOR SELECT
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
ALTER TABLE public.jarvis_dispatch_directory_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jarvis_dispatch_directory_cursors FORCE ROW LEVEL SECURITY;

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

DO $bob_jarvis_u1l_cursor_data_api$
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
$bob_jarvis_u1l_cursor_data_api$;

RESET ROLE;

CREATE FUNCTION public.claim_jarvis_dispatch_coordinates_v2(
  company_id TEXT,
  batch_limit INTEGER,
  requested_claim_id UUID
)
RETURNS TABLE (
  status TEXT,
  "companyId" TEXT,
  "claimId" UUID,
  "position" INTEGER,
  "pageSize" INTEGER,
  "ownerUserId" TEXT,
  "runId" UUID,
  "hasMore" BOOLEAN,
  replayed BOOLEAN,
  "databaseNow" TIMESTAMPTZ,
  "claimHardExpiresAt" TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_dispatch_claim_v2$
DECLARE
  cursor_after_owner TEXT;
  cursor_after_run UUID;
  cursor_upper_owner TEXT;
  cursor_upper_run UUID;
  cursor_cutoff TIMESTAMPTZ;
  pending_owners TEXT[];
  pending_runs UUID[];
  pending_after_owner TEXT;
  pending_after_run UUID;
  pending_has_more BOOLEAN;
  pending_next_position INTEGER;
  active_claim_id UUID;
  active_claim_expires_at TIMESTAMPTZ;
  active_claim_hard_expires_at TIMESTAMPTZ;
  operation_now TIMESTAMPTZ;
  scanned_owners TEXT[];
  scanned_runs UUID[];
  selected_owners TEXT[];
  selected_runs UUID[];
  scanned_count INTEGER;
  selected_count INTEGER;
  selected_has_more BOOLEAN;
BEGIN
  IF current_user <> 'bob_jarvis_dispatch_directory' THEN
    RAISE EXCEPTION 'jarvis dispatch directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR batch_limit IS NULL
     OR batch_limit < 1
     OR batch_limit > 50
     OR requested_claim_id IS NULL
     OR requested_claim_id = '00000000-0000-0000-0000-000000000000'::UUID THEN
    RAISE EXCEPTION 'jarvis dispatch directory claim rejected'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.jarvis_dispatch_directory_cursors ("companyId")
  VALUES (company_id)
  ON CONFLICT ON CONSTRAINT jarvis_dispatch_directory_cursors_pkey DO NOTHING;

  SELECT cursor."afterOwnerUserId", cursor."afterRunId",
         cursor."cycleUpperOwnerUserId", cursor."cycleUpperRunId", cursor."cycleCutoffAt",
         cursor."pendingOwnerUserIds", cursor."pendingRunIds",
         cursor."pendingAfterOwnerUserId", cursor."pendingAfterRunId",
         cursor."pendingHasMore", cursor."pendingNextPosition",
         cursor."claimId", cursor."claimExpiresAt", cursor."claimHardExpiresAt"
    INTO STRICT cursor_after_owner, cursor_after_run,
                cursor_upper_owner, cursor_upper_run, cursor_cutoff,
                pending_owners, pending_runs, pending_after_owner, pending_after_run,
                pending_has_more, pending_next_position,
                active_claim_id, active_claim_expires_at, active_claim_hard_expires_at
    FROM public.jarvis_dispatch_directory_cursors AS cursor
   WHERE cursor."companyId" = company_id
   FOR UPDATE;

  -- Horloge unique capturée APRES acquisition du verrou : une attente ne peut jamais prolonger
  -- artificiellement un claim ou démarrer une position au-delà de son échéance dure.
  operation_now := pg_catalog.clock_timestamp();

  IF active_claim_id IS NOT NULL THEN
    IF active_claim_expires_at > operation_now
       AND active_claim_hard_expires_at > operation_now THEN
      RETURN QUERY
        SELECT 'busy'::TEXT, company_id, NULL::UUID, NULL::INTEGER, NULL::INTEGER,
               NULL::TEXT, NULL::UUID, NULL::BOOLEAN, NULL::BOOLEAN,
               NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;

    IF active_claim_id = requested_claim_id THEN
      RAISE EXCEPTION 'jarvis dispatch directory replacement claim must be fresh'
        USING ERRCODE = '22023';
    END IF;

    active_claim_expires_at := operation_now + INTERVAL '30 seconds';
    active_claim_hard_expires_at := operation_now + INTERVAL '5 minutes';
    UPDATE public.jarvis_dispatch_directory_cursors AS cursor
       SET "claimId" = requested_claim_id,
           "claimExpiresAt" = active_claim_expires_at,
           "claimHardExpiresAt" = active_claim_hard_expires_at,
           revision = cursor.revision + 1
     WHERE cursor."companyId" = company_id
       AND cursor."claimId" = active_claim_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'jarvis dispatch directory claim compare-and-set rejected';
    END IF;

    selected_count := cardinality(pending_owners);
    IF pending_next_position = selected_count + 1 THEN
      RETURN QUERY
        SELECT 'ack_ready'::TEXT, company_id, requested_claim_id,
               NULL::INTEGER, selected_count, NULL::TEXT, NULL::UUID,
               pending_has_more, TRUE, operation_now, active_claim_hard_expires_at;
      RETURN;
    END IF;

    RETURN QUERY
      SELECT 'claimed'::TEXT, company_id, requested_claim_id,
             slot.slot_index, selected_count,
             pending_owners[slot.slot_index], pending_runs[slot.slot_index],
             pending_has_more, TRUE, operation_now, active_claim_hard_expires_at
        FROM pg_catalog.generate_series(
          pending_next_position, selected_count
        ) AS slot(slot_index)
       ORDER BY slot.slot_index;
    RETURN;
  END IF;

  IF cursor_upper_owner IS NULL THEN
    cursor_cutoff := operation_now;
    SELECT candidate.owner_id, candidate.run_id
      INTO cursor_upper_owner, cursor_upper_run
      FROM (
        SELECT DISTINCT due."ownerUserId" COLLATE "C" AS owner_id,
                        due."runId" AS run_id
          FROM public.jarvis_work_items AS due
         WHERE due."companyId" = company_id
           AND due."updatedAt" <= cursor_cutoff
           AND (
             (
               due."status" IN ('prepared', 'retry_due')
               AND (due."nextAttemptAt" IS NULL OR due."nextAttemptAt" <= cursor_cutoff)
             )
             OR (
               due."status" = 'leased'
               AND due."leaseExpiresAt" IS NOT NULL
               AND due."leaseExpiresAt" < cursor_cutoff
             )
             OR (
               due."status" = 'authorized'
               AND due."resultDigest" IS NULL
               AND due."leaseExpiresAt" IS NOT NULL
               AND due."leaseExpiresAt" < cursor_cutoff
             )
             OR (
               due."status" IN ('succeeded', 'failed_terminal', 'cancelled')
               AND due."resultDigest" IS NOT NULL
               AND due."signalAppliedAt" IS NULL
               AND (
                 due."status" <> 'succeeded'
                 OR (
                   due."authorizedAt" IS NOT NULL
                   AND due."authorizationDigest" IS NOT NULL
                 )
               )
               AND (
                 due."status" <> 'cancelled'
                 OR (
                   due."authorizedAt" IS NULL
                   AND due."authorizationDigest" IS NULL
                 )
               )
             )
           )
      ) AS candidate
     ORDER BY candidate.owner_id COLLATE "C" DESC, candidate.run_id DESC
     LIMIT 1;
  END IF;

  IF cursor_upper_owner IS NOT NULL THEN
    SELECT pg_catalog.array_agg(
             candidate.owner_id ORDER BY candidate.owner_id COLLATE "C", candidate.run_id
           ),
           pg_catalog.array_agg(
             candidate.run_id ORDER BY candidate.owner_id COLLATE "C", candidate.run_id
           )
      INTO scanned_owners, scanned_runs
      FROM (
        SELECT DISTINCT due."ownerUserId" COLLATE "C" AS owner_id,
                        due."runId" AS run_id
          FROM public.jarvis_work_items AS due
         WHERE due."companyId" = company_id
           AND (
             cursor_after_owner IS NULL
             OR (
               ROW(due."ownerUserId" COLLATE "C", due."runId")
                 > ROW(cursor_after_owner COLLATE "C", cursor_after_run)
             ) IS TRUE
           )
           AND (
             ROW(due."ownerUserId" COLLATE "C", due."runId")
               <= ROW(cursor_upper_owner COLLATE "C", cursor_upper_run)
           ) IS TRUE
           AND due."updatedAt" <= cursor_cutoff
           AND (
             (
               due."status" IN ('prepared', 'retry_due')
               AND (due."nextAttemptAt" IS NULL OR due."nextAttemptAt" <= cursor_cutoff)
             )
             OR (
               due."status" = 'leased'
               AND due."leaseExpiresAt" IS NOT NULL
               AND due."leaseExpiresAt" < cursor_cutoff
             )
             OR (
               due."status" = 'authorized'
               AND due."resultDigest" IS NULL
               AND due."leaseExpiresAt" IS NOT NULL
               AND due."leaseExpiresAt" < cursor_cutoff
             )
             OR (
               due."status" IN ('succeeded', 'failed_terminal', 'cancelled')
               AND due."resultDigest" IS NOT NULL
               AND due."signalAppliedAt" IS NULL
               AND (
                 due."status" <> 'succeeded'
                 OR (
                   due."authorizedAt" IS NOT NULL
                   AND due."authorizationDigest" IS NOT NULL
                 )
               )
               AND (
                 due."status" <> 'cancelled'
                 OR (
                   due."authorizedAt" IS NULL
                   AND due."authorizationDigest" IS NULL
                 )
               )
             )
           )
         ORDER BY due."ownerUserId" COLLATE "C", due."runId"
         LIMIT batch_limit + 1
      ) AS candidate;
  END IF;

  scanned_count := COALESCE(cardinality(scanned_owners), 0);
  IF scanned_count = 0 THEN
    UPDATE public.jarvis_dispatch_directory_cursors AS cursor
       SET "afterOwnerUserId" = NULL,
           "afterRunId" = NULL,
           "cycleUpperOwnerUserId" = NULL,
           "cycleUpperRunId" = NULL,
           "cycleCutoffAt" = NULL,
           revision = cursor.revision + 1
     WHERE cursor."companyId" = company_id
       AND cursor."claimId" IS NULL;

    RETURN QUERY
      SELECT 'empty'::TEXT, company_id, NULL::UUID, NULL::INTEGER, NULL::INTEGER,
             NULL::TEXT, NULL::UUID, NULL::BOOLEAN, NULL::BOOLEAN,
             NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  selected_count := LEAST(scanned_count, batch_limit);
  selected_owners := scanned_owners[1:selected_count];
  selected_runs := scanned_runs[1:selected_count];
  selected_has_more := scanned_count > selected_count;
  active_claim_expires_at := operation_now + INTERVAL '30 seconds';
  active_claim_hard_expires_at := operation_now + INTERVAL '5 minutes';

  UPDATE public.jarvis_dispatch_directory_cursors AS cursor
     SET "cycleUpperOwnerUserId" = cursor_upper_owner,
         "cycleUpperRunId" = cursor_upper_run,
         "cycleCutoffAt" = cursor_cutoff,
         "pendingOwnerUserIds" = selected_owners,
         "pendingRunIds" = selected_runs,
         "pendingAfterOwnerUserId" = selected_owners[selected_count],
         "pendingAfterRunId" = selected_runs[selected_count],
         "pendingHasMore" = selected_has_more,
         "pendingNextPosition" = 1,
         "claimId" = requested_claim_id,
         "claimExpiresAt" = active_claim_expires_at,
         "claimHardExpiresAt" = active_claim_hard_expires_at,
         revision = cursor.revision + 1
   WHERE cursor."companyId" = company_id
     AND cursor."claimId" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jarvis dispatch directory fresh claim compare-and-set rejected';
  END IF;

  RETURN QUERY
    SELECT 'claimed'::TEXT, company_id, requested_claim_id,
           slot.slot_index, selected_count,
           selected_owners[slot.slot_index], selected_runs[slot.slot_index],
           selected_has_more, FALSE, operation_now, active_claim_hard_expires_at
      FROM pg_catalog.generate_series(1, selected_count) AS slot(slot_index)
     ORDER BY slot.slot_index;
END;
$bob_jarvis_dispatch_claim_v2$;

REVOKE ALL ON FUNCTION public.claim_jarvis_dispatch_coordinates_v2(TEXT, INTEGER, UUID)
  FROM PUBLIC;

CREATE FUNCTION public.renew_jarvis_dispatch_coordinates_claim_v2(
  company_id TEXT,
  requested_claim_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_dispatch_renew_v2$
DECLARE
  active_claim_id UUID;
  active_claim_hard_expires_at TIMESTAMPTZ;
  operation_now TIMESTAMPTZ;
BEGIN
  IF current_user <> 'bob_jarvis_dispatch_directory' THEN
    RAISE EXCEPTION 'jarvis dispatch directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR requested_claim_id IS NULL
     OR requested_claim_id = '00000000-0000-0000-0000-000000000000'::UUID THEN
    RAISE EXCEPTION 'jarvis dispatch directory renewal rejected'
      USING ERRCODE = '22023';
  END IF;

  SELECT cursor."claimId", cursor."claimHardExpiresAt"
    INTO active_claim_id, active_claim_hard_expires_at
    FROM public.jarvis_dispatch_directory_cursors AS cursor
   WHERE cursor."companyId" = company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  operation_now := pg_catalog.clock_timestamp();

  IF active_claim_id IS DISTINCT FROM requested_claim_id
     OR active_claim_hard_expires_at IS NULL
     OR active_claim_hard_expires_at <= operation_now THEN
    RETURN FALSE;
  END IF;

  UPDATE public.jarvis_dispatch_directory_cursors AS cursor
     SET "claimExpiresAt" = LEAST(
           operation_now + INTERVAL '30 seconds', cursor."claimHardExpiresAt"
         ),
         revision = cursor.revision + 1
   WHERE cursor."companyId" = company_id
     AND cursor."claimId" = requested_claim_id
     AND cursor."claimHardExpiresAt" > operation_now;
  RETURN FOUND;
END;
$bob_jarvis_dispatch_renew_v2$;

REVOKE ALL ON FUNCTION public.renew_jarvis_dispatch_coordinates_claim_v2(TEXT, UUID)
  FROM PUBLIC;

CREATE FUNCTION public.start_jarvis_dispatch_coordinate_v2(
  company_id TEXT,
  requested_claim_id UUID,
  requested_position INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_dispatch_start_v2$
DECLARE
  active_claim_id UUID;
  active_claim_hard_expires_at TIMESTAMPTZ;
  active_next_position INTEGER;
  active_page_size INTEGER;
  operation_now TIMESTAMPTZ;
BEGIN
  IF current_user <> 'bob_jarvis_dispatch_directory' THEN
    RAISE EXCEPTION 'jarvis dispatch directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR requested_claim_id IS NULL
     OR requested_claim_id = '00000000-0000-0000-0000-000000000000'::UUID
     OR requested_position IS NULL
     OR requested_position < 1
     OR requested_position > 50 THEN
    RAISE EXCEPTION 'jarvis dispatch directory start rejected'
      USING ERRCODE = '22023';
  END IF;

  SELECT cursor."claimId", cursor."claimHardExpiresAt",
         cursor."pendingNextPosition", cardinality(cursor."pendingOwnerUserIds")
    INTO active_claim_id, active_claim_hard_expires_at,
         active_next_position, active_page_size
    FROM public.jarvis_dispatch_directory_cursors AS cursor
   WHERE cursor."companyId" = company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  operation_now := pg_catalog.clock_timestamp();

  IF active_claim_id IS DISTINCT FROM requested_claim_id
     OR active_claim_hard_expires_at IS NULL
     OR active_claim_hard_expires_at <= operation_now
     OR active_next_position IS DISTINCT FROM requested_position
     OR requested_position > active_page_size THEN
    RETURN FALSE;
  END IF;

  UPDATE public.jarvis_dispatch_directory_cursors AS cursor
     SET "pendingNextPosition" = cursor."pendingNextPosition" + 1,
         "claimExpiresAt" = LEAST(
           operation_now + INTERVAL '30 seconds', cursor."claimHardExpiresAt"
         ),
         revision = cursor.revision + 1
   WHERE cursor."companyId" = company_id
     AND cursor."claimId" = requested_claim_id
     AND cursor."claimHardExpiresAt" > operation_now
     AND cursor."pendingNextPosition" = requested_position
     AND requested_position <= cardinality(cursor."pendingOwnerUserIds");
  RETURN FOUND;
END;
$bob_jarvis_dispatch_start_v2$;

REVOKE ALL ON FUNCTION public.start_jarvis_dispatch_coordinate_v2(TEXT, UUID, INTEGER)
  FROM PUBLIC;

CREATE FUNCTION public.ack_jarvis_dispatch_coordinates_v2(
  company_id TEXT,
  requested_claim_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_dispatch_ack_v2$
DECLARE
  active_claim_id UUID;
  active_next_position INTEGER;
  active_page_size INTEGER;
  operation_now TIMESTAMPTZ;
BEGIN
  IF current_user <> 'bob_jarvis_dispatch_directory' THEN
    RAISE EXCEPTION 'jarvis dispatch directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR requested_claim_id IS NULL
     OR requested_claim_id = '00000000-0000-0000-0000-000000000000'::UUID THEN
    RAISE EXCEPTION 'jarvis dispatch directory acknowledgement rejected'
      USING ERRCODE = '22023';
  END IF;

  SELECT cursor."claimId", cursor."pendingNextPosition",
         cardinality(cursor."pendingOwnerUserIds")
    INTO active_claim_id, active_next_position, active_page_size
    FROM public.jarvis_dispatch_directory_cursors AS cursor
   WHERE cursor."companyId" = company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  operation_now := pg_catalog.clock_timestamp();

  IF active_claim_id IS DISTINCT FROM requested_claim_id
     OR active_next_position IS DISTINCT FROM active_page_size + 1 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.jarvis_dispatch_directory_cursors AS cursor
     SET "afterOwnerUserId" = CASE
           WHEN cursor."pendingHasMore" THEN cursor."pendingAfterOwnerUserId"
           ELSE NULL
         END,
         "afterRunId" = CASE
           WHEN cursor."pendingHasMore" THEN cursor."pendingAfterRunId"
           ELSE NULL
         END,
         "cycleUpperOwnerUserId" = CASE
           WHEN cursor."pendingHasMore" THEN cursor."cycleUpperOwnerUserId"
           ELSE NULL
         END,
         "cycleUpperRunId" = CASE
           WHEN cursor."pendingHasMore" THEN cursor."cycleUpperRunId"
           ELSE NULL
         END,
         "cycleCutoffAt" = CASE
           WHEN cursor."pendingHasMore" THEN cursor."cycleCutoffAt"
           ELSE NULL
         END,
         "pendingOwnerUserIds" = ARRAY[]::TEXT[],
         "pendingRunIds" = ARRAY[]::UUID[],
         "pendingAfterOwnerUserId" = NULL,
         "pendingAfterRunId" = NULL,
         "pendingHasMore" = NULL,
         "pendingNextPosition" = NULL,
         "claimId" = NULL,
         "claimExpiresAt" = NULL,
         "claimHardExpiresAt" = NULL,
         revision = cursor.revision + 1
   WHERE cursor."companyId" = company_id
     AND cursor."claimId" = requested_claim_id
     AND cursor."pendingNextPosition" = cardinality(cursor."pendingOwnerUserIds") + 1;
  RETURN FOUND;
END;
$bob_jarvis_dispatch_ack_v2$;

REVOKE ALL ON FUNCTION public.ack_jarvis_dispatch_coordinates_v2(TEXT, UUID)
  FROM PUBLIC;

DO $bob_jarvis_u1l_function_data_api$
DECLARE
  exposed_role TEXT;
  function_signature TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH function_signature IN ARRAY ARRAY[
      'public.claim_jarvis_dispatch_coordinates_v2(TEXT, INTEGER, UUID)',
      'public.renew_jarvis_dispatch_coordinates_claim_v2(TEXT, UUID)',
      'public.start_jarvis_dispatch_coordinate_v2(TEXT, UUID, INTEGER)',
      'public.ack_jarvis_dispatch_coordinates_v2(TEXT, UUID)'
    ]::TEXT[] LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        function_signature,
        exposed_role
      );
    END LOOP;
  END LOOP;
END;
$bob_jarvis_u1l_function_data_api$;

COMMIT;
