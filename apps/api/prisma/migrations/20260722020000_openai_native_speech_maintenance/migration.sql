-- Bob Live GPT Realtime natif — protocole de maintenance durable, équitable et borné.
-- Les quatre indexes opérationnels vivent chacun dans une migration CONCURRENTLY distincte :
-- Prisma traite un fichier comme un bloc et PostgreSQL refuse CONCURRENTLY dans un tel bloc.

BEGIN;

-- Deux curseurs globaux techniques, sans contenu métier. Leur verrou de ligne sérialise la
-- découverte entre pods ; leur tuple keyset survit aux redémarrages et empêche toute famine.
CREATE TABLE public.realtime_native_speech_maintenance_cursors (
  lane TEXT PRIMARY KEY,
  "afterDueAt" TIMESTAMPTZ,
  "afterCompanyId" TEXT,
  "afterDeliveryId" UUID,
  "cycleUpperDueAt" TIMESTAMPTZ,
  "cycleUpperCompanyId" TEXT,
  "cycleUpperDeliveryId" UUID,
  "pendingCompanyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "pendingAfterDueAt" TIMESTAMPTZ,
  "pendingAfterCompanyId" TEXT,
  "pendingAfterDeliveryId" UUID,
  "pendingHasMore" BOOLEAN,
  "claimId" UUID,
  "claimExpiresAt" TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT realtime_native_speech_maintenance_cursor_lane_check
    CHECK (lane IN ('expiry', 'retention')),
  CONSTRAINT realtime_native_speech_maintenance_cursor_tuple_check
    CHECK (
      (("afterDueAt" IS NULL) = ("afterCompanyId" IS NULL))
      AND (("afterDueAt" IS NULL) = ("afterDeliveryId" IS NULL))
      AND (("cycleUpperDueAt" IS NULL) = ("cycleUpperCompanyId" IS NULL))
      AND (("cycleUpperDueAt" IS NULL) = ("cycleUpperDeliveryId" IS NULL))
      AND ("afterDueAt" IS NULL OR "cycleUpperDueAt" IS NOT NULL)
      AND (
        "afterDueAt" IS NULL
        OR ("afterDueAt", "afterCompanyId", "afterDeliveryId")
           <= ("cycleUpperDueAt", "cycleUpperCompanyId", "cycleUpperDeliveryId")
      )
    ),
  CONSTRAINT realtime_native_speech_maintenance_cursor_claim_check
    CHECK (
      (
        cardinality("pendingCompanyIds") = 0
        AND "pendingAfterDueAt" IS NULL AND "pendingAfterCompanyId" IS NULL
        AND "pendingAfterDeliveryId" IS NULL AND "pendingHasMore" IS NULL
        AND "claimId" IS NULL AND "claimExpiresAt" IS NULL
      )
      OR
      (
        cardinality("pendingCompanyIds") BETWEEN 1 AND 1000
        AND "pendingAfterDueAt" IS NOT NULL AND "pendingAfterCompanyId" IS NOT NULL
        AND "pendingAfterDeliveryId" IS NOT NULL AND "pendingHasMore" IS NOT NULL
        AND "claimId" IS NOT NULL AND "claimExpiresAt" IS NOT NULL
        AND "cycleUpperDueAt" IS NOT NULL AND "cycleUpperCompanyId" IS NOT NULL
        AND "cycleUpperDeliveryId" IS NOT NULL
        AND ("pendingAfterDueAt", "pendingAfterCompanyId", "pendingAfterDeliveryId")
            <= ("cycleUpperDueAt", "cycleUpperCompanyId", "cycleUpperDeliveryId")
      )
    ),
  CONSTRAINT realtime_native_speech_maintenance_cursor_revision_check
    CHECK (revision >= 0)
);

INSERT INTO public.realtime_native_speech_maintenance_cursors(lane)
VALUES ('expiry'), ('retention');

REVOKE ALL ON TABLE public.realtime_native_speech_maintenance_cursors FROM PUBLIC;

-- La table peut hériter d'anciens DEFAULT PRIVILEGES applicatifs pendant un rolling deploy.
-- FORCE RLS ferme cette fenêtre dès la migration, avant les indexes CONCURRENTLY suivants.
ALTER TABLE public.realtime_native_speech_maintenance_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_native_speech_maintenance_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_native_speech_maintenance_cursor_directory_select
  ON public.realtime_native_speech_maintenance_cursors
  FOR SELECT
  USING (current_user = 'bob_openai_native_maintenance_directory');
CREATE POLICY realtime_native_speech_maintenance_cursor_directory_update
  ON public.realtime_native_speech_maintenance_cursors
  FOR UPDATE
  USING (current_user = 'bob_openai_native_maintenance_directory')
  WITH CHECK (current_user = 'bob_openai_native_maintenance_directory');

-- Découverte globale minimale : au plus batch_limit + 1 lignes indexées sont inspectées. Le
-- curseur avance sur la dernière ligne consommée, pas sur le dernier tenant dédupliqué. Un tenant
-- saturé fait donc progresser le scan au lieu d'affamer éternellement les suivants.
CREATE FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(
  maintenance_lane TEXT,
  batch_limit INTEGER,
  claim_id UUID
)
RETURNS TABLE ("companyId" TEXT, "hasMore" BOOLEAN, "claimId" UUID)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
AS $$
DECLARE
  observed_at TIMESTAMPTZ := statement_timestamp();
  cursor_due_at TIMESTAMPTZ;
  cursor_company_id TEXT;
  cursor_delivery_id UUID;
  cycle_upper_due_at TIMESTAMPTZ;
  cycle_upper_company_id TEXT;
  cycle_upper_delivery_id UUID;
  pending_company_ids TEXT[];
  pending_has_more BOOLEAN;
  active_claim_id UUID;
  active_claim_expires_at TIMESTAMPTZ;
  scanned_company_ids TEXT[];
  scanned_due_ats TIMESTAMPTZ[];
  scanned_delivery_ids UUID[];
  claimed_company_ids TEXT[];
  scanned_count INTEGER := 0;
  consumed_count INTEGER := 0;
  scan_has_more BOOLEAN := FALSE;
BEGIN
  IF current_user <> 'bob_openai_native_maintenance_directory' THEN
    RAISE EXCEPTION 'realtime native maintenance directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF maintenance_lane NOT IN ('expiry', 'retention') THEN
    RAISE EXCEPTION 'realtime native maintenance lane rejected'
      USING ERRCODE = '22023';
  END IF;
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 OR claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime native maintenance claim rejected'
      USING ERRCODE = '22023';
  END IF;

  SELECT cursor."afterDueAt", cursor."afterCompanyId", cursor."afterDeliveryId",
         cursor."cycleUpperDueAt", cursor."cycleUpperCompanyId", cursor."cycleUpperDeliveryId",
         cursor."pendingCompanyIds", cursor."pendingHasMore", cursor."claimId",
         cursor."claimExpiresAt"
    INTO STRICT cursor_due_at, cursor_company_id, cursor_delivery_id,
                cycle_upper_due_at, cycle_upper_company_id, cycle_upper_delivery_id,
                pending_company_ids, pending_has_more, active_claim_id,
                active_claim_expires_at
    FROM public.realtime_native_speech_maintenance_cursors AS cursor
   WHERE cursor.lane = maintenance_lane
   FOR UPDATE;

  -- Un claim vivant appartient à un autre pod. Un claim expiré est relivré à l'identique avec un
  -- nouveau token ; le curseur n'avance jamais sans ACK durable.
  IF active_claim_id IS NOT NULL THEN
    IF active_claim_expires_at > observed_at THEN
      RETURN;
    END IF;
    UPDATE public.realtime_native_speech_maintenance_cursors AS cursor
       SET "claimId" = claim_id,
           "claimExpiresAt" = observed_at + INTERVAL '30 seconds',
           revision = cursor.revision + 1
     WHERE cursor.lane = maintenance_lane;
    RETURN QUERY
      SELECT pending_company_ids[position], pending_has_more, claim_id
        FROM generate_subscripts(pending_company_ids, 1) AS position
       ORDER BY position;
    RETURN;
  END IF;

  -- La borne haute fige un cycle fini : même sous arrivée continue, une page jamais ACKée est
  -- rejouée après 30 s et les nouvelles lignes attendent le cycle suivant sans affamer l'historique.
  IF cycle_upper_due_at IS NULL THEN
    IF maintenance_lane = 'expiry' THEN
      SELECT delivery."expiresAt", delivery."companyId", delivery."deliveryId"
        INTO cycle_upper_due_at, cycle_upper_company_id, cycle_upper_delivery_id
        FROM public.realtime_native_speech_deliveries AS delivery
       WHERE delivery.phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
         AND delivery."expiresAt" <= observed_at
       ORDER BY delivery."expiresAt" DESC, delivery."companyId" DESC,
                delivery."deliveryId" DESC
       LIMIT 1;
    ELSE
      SELECT delivery."retentionExpiresAt", delivery."companyId", delivery."deliveryId"
        INTO cycle_upper_due_at, cycle_upper_company_id, cycle_upper_delivery_id
        FROM public.realtime_native_speech_deliveries AS delivery
       WHERE delivery.phase IN ('delivered', 'cancelled', 'failed', 'expired')
         AND delivery."retentionExpiresAt" <= observed_at
       ORDER BY delivery."retentionExpiresAt" DESC, delivery."companyId" DESC,
                delivery."deliveryId" DESC
       LIMIT 1;
    END IF;
  END IF;

  IF cycle_upper_due_at IS NULL THEN
    RETURN;
  END IF;

  IF maintenance_lane = 'expiry' THEN
    SELECT array_agg(candidate."companyId" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId"),
           array_agg(candidate."dueAt" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId"),
           array_agg(candidate."deliveryId" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId")
      INTO scanned_company_ids, scanned_due_ats, scanned_delivery_ids
      FROM (
        SELECT delivery."companyId", delivery."expiresAt" AS "dueAt", delivery."deliveryId"
          FROM public.realtime_native_speech_deliveries AS delivery
         WHERE delivery.phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
           AND delivery."expiresAt" <= observed_at
           AND (
             cursor_due_at IS NULL
             OR (delivery."expiresAt", delivery."companyId", delivery."deliveryId")
                > (cursor_due_at, cursor_company_id, cursor_delivery_id)
           )
           AND (delivery."expiresAt", delivery."companyId", delivery."deliveryId")
               <= (cycle_upper_due_at, cycle_upper_company_id, cycle_upper_delivery_id)
         ORDER BY delivery."expiresAt", delivery."companyId", delivery."deliveryId"
         LIMIT batch_limit + 1
      ) AS candidate;
  ELSE
    SELECT array_agg(candidate."companyId" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId"),
           array_agg(candidate."dueAt" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId"),
           array_agg(candidate."deliveryId" ORDER BY candidate."dueAt", candidate."companyId",
                     candidate."deliveryId")
      INTO scanned_company_ids, scanned_due_ats, scanned_delivery_ids
      FROM (
        SELECT delivery."companyId", delivery."retentionExpiresAt" AS "dueAt",
               delivery."deliveryId"
          FROM public.realtime_native_speech_deliveries AS delivery
         WHERE delivery.phase IN ('delivered', 'cancelled', 'failed', 'expired')
           AND delivery."retentionExpiresAt" <= observed_at
           AND (
             cursor_due_at IS NULL
             OR (delivery."retentionExpiresAt", delivery."companyId", delivery."deliveryId")
                > (cursor_due_at, cursor_company_id, cursor_delivery_id)
           )
           AND (delivery."retentionExpiresAt", delivery."companyId", delivery."deliveryId")
               <= (cycle_upper_due_at, cycle_upper_company_id, cycle_upper_delivery_id)
         ORDER BY delivery."retentionExpiresAt", delivery."companyId", delivery."deliveryId"
         LIMIT batch_limit + 1
      ) AS candidate;
  END IF;

  scanned_count := COALESCE(cardinality(scanned_company_ids), 0);
  IF scanned_count = 0 THEN
    UPDATE public.realtime_native_speech_maintenance_cursors AS cursor
       SET "afterDueAt" = NULL,
           "afterCompanyId" = NULL,
           "afterDeliveryId" = NULL,
           "cycleUpperDueAt" = NULL,
           "cycleUpperCompanyId" = NULL,
           "cycleUpperDeliveryId" = NULL,
           revision = cursor.revision + 1
     WHERE cursor.lane = maintenance_lane;
    RETURN;
  END IF;

  consumed_count := LEAST(scanned_count, batch_limit);
  scan_has_more := scanned_count > batch_limit;
  SELECT array_agg(selected."companyId" ORDER BY selected.first_position)
    INTO claimed_company_ids
    FROM (
      SELECT scanned_company_ids[position] AS "companyId", MIN(position) AS first_position
        FROM generate_subscripts(scanned_company_ids, 1) AS position
       WHERE position <= consumed_count
       GROUP BY scanned_company_ids[position]
    ) AS selected;

  UPDATE public.realtime_native_speech_maintenance_cursors AS cursor
     SET "cycleUpperDueAt" = cycle_upper_due_at,
         "cycleUpperCompanyId" = cycle_upper_company_id,
         "cycleUpperDeliveryId" = cycle_upper_delivery_id,
         "pendingCompanyIds" = claimed_company_ids,
         "pendingAfterDueAt" = scanned_due_ats[consumed_count],
         "pendingAfterCompanyId" = scanned_company_ids[consumed_count],
         "pendingAfterDeliveryId" = scanned_delivery_ids[consumed_count],
         "pendingHasMore" = scan_has_more,
         "claimId" = claim_id,
         "claimExpiresAt" = observed_at + INTERVAL '30 seconds',
         revision = cursor.revision + 1
   WHERE cursor.lane = maintenance_lane;

  RETURN QUERY
    SELECT claimed_company_ids[position], scan_has_more, claim_id
      FROM generate_subscripts(claimed_company_ids, 1) AS position
     ORDER BY position;
END;
$$;

REVOKE ALL ON FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(
  TEXT, INTEGER, UUID
) FROM PUBLIC;

CREATE FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(
  maintenance_lane TEXT,
  claim_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
AS $$
DECLARE
  pending_has_more BOOLEAN;
  pending_after_due_at TIMESTAMPTZ;
  pending_after_company_id TEXT;
  pending_after_delivery_id UUID;
BEGIN
  IF current_user <> 'bob_openai_native_maintenance_directory' THEN
    RAISE EXCEPTION 'realtime native maintenance directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF maintenance_lane NOT IN ('expiry', 'retention') OR claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime native maintenance acknowledgement rejected'
      USING ERRCODE = '22023';
  END IF;

  SELECT cursor."pendingHasMore", cursor."pendingAfterDueAt",
         cursor."pendingAfterCompanyId", cursor."pendingAfterDeliveryId"
    INTO pending_has_more, pending_after_due_at,
         pending_after_company_id, pending_after_delivery_id
    FROM public.realtime_native_speech_maintenance_cursors AS cursor
   WHERE cursor.lane = maintenance_lane
     AND cursor."claimId" = claim_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.realtime_native_speech_maintenance_cursors AS cursor
     SET "afterDueAt" = CASE WHEN pending_has_more THEN pending_after_due_at ELSE NULL END,
         "afterCompanyId" = CASE WHEN pending_has_more THEN pending_after_company_id ELSE NULL END,
         "afterDeliveryId" = CASE WHEN pending_has_more THEN pending_after_delivery_id ELSE NULL END,
         "cycleUpperDueAt" = CASE WHEN pending_has_more THEN cursor."cycleUpperDueAt" ELSE NULL END,
         "cycleUpperCompanyId" = CASE WHEN pending_has_more THEN cursor."cycleUpperCompanyId" ELSE NULL END,
         "cycleUpperDeliveryId" = CASE WHEN pending_has_more THEN cursor."cycleUpperDeliveryId" ELSE NULL END,
         "pendingCompanyIds" = ARRAY[]::TEXT[],
         "pendingAfterDueAt" = NULL,
         "pendingAfterCompanyId" = NULL,
         "pendingAfterDeliveryId" = NULL,
         "pendingHasMore" = NULL,
         "claimId" = NULL,
         "claimExpiresAt" = NULL,
         revision = cursor.revision + 1
   WHERE cursor.lane = maintenance_lane;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID)
  FROM PUBLIC;

CREATE FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(
  maintenance_lane TEXT,
  claim_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
AS $$
BEGIN
  IF current_user <> 'bob_openai_native_maintenance_directory' THEN
    RAISE EXCEPTION 'realtime native maintenance directory authority required'
      USING ERRCODE = '42501';
  END IF;
  IF maintenance_lane NOT IN ('expiry', 'retention') OR claim_id IS NULL THEN
    RAISE EXCEPTION 'realtime native maintenance renewal rejected'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.realtime_native_speech_maintenance_cursors AS cursor
     SET "claimExpiresAt" = statement_timestamp() + INTERVAL '30 seconds',
         revision = cursor.revision + 1
   WHERE cursor.lane = maintenance_lane
     AND cursor."claimId" = claim_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID)
  FROM PUBLIC;

CREATE FUNCTION public.guard_realtime_native_delivery_delete_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  -- DIRECT_URL conserve la capacité d'administration/cleanup. Le runtime reçoit explicitement
  -- zéro privilège TRIGGER dans release.sh et traverse donc toujours les fences ci-dessous.
  IF has_table_privilege(session_user, TG_RELID, 'TRIGGER') THEN
    RETURN OLD;
  END IF;

  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM OLD."companyId"
  THEN
    RAISE EXCEPTION 'realtime native delivery delete tenant context rejected'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
     OR OLD."retentionExpiresAt" > statement_timestamp()
     OR EXISTS (
       SELECT 1
         FROM public.realtime_control_grants AS control_grant
        WHERE control_grant."companyId" = OLD."companyId"
          AND control_grant."nativeDeliveryId" = OLD."deliveryId"
     )
  THEN
    RAISE EXCEPTION 'realtime native delivery retention fence rejected delete'
      USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_delete_v1() FROM PUBLIC;

CREATE TRIGGER "02_realtime_native_speech_deliveries_delete_guard_v1"
BEFORE DELETE ON public.realtime_native_speech_deliveries
FOR EACH ROW EXECUTE FUNCTION public.guard_realtime_native_delivery_delete_v1();

CREATE FUNCTION public.deny_realtime_native_delivery_truncate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'realtime native delivery truncate is forbidden'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.deny_realtime_native_delivery_truncate_v1() FROM PUBLIC;

CREATE TRIGGER "03_realtime_native_speech_deliveries_truncate_guard_v1"
BEFORE TRUNCATE ON public.realtime_native_speech_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION public.deny_realtime_native_delivery_truncate_v1();

-- Une policy permissive fournit l'isolation tenant. La policy RESTRICTIVE reste un ET obligatoire,
-- même si une future migration ajoute par erreur une autre policy DELETE permissive.
DROP POLICY IF EXISTS realtime_native_speech_delivery_delete_tenant
  ON public.realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_delete_retention_fence
  ON public.realtime_native_speech_deliveries;
DROP POLICY IF EXISTS realtime_native_speech_delivery_due_directory_select
  ON public.realtime_native_speech_deliveries;

CREATE POLICY realtime_native_speech_delivery_due_directory_select
  ON public.realtime_native_speech_deliveries
  FOR SELECT
  USING (
    current_user = 'bob_openai_native_maintenance_directory'
    AND (
      (
        phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
        AND "expiresAt" <= statement_timestamp()
      )
      OR (
        phase IN ('delivered', 'cancelled', 'failed', 'expired')
        AND "retentionExpiresAt" <= statement_timestamp()
      )
    )
  );

CREATE POLICY realtime_native_speech_delivery_delete_tenant
  ON public.realtime_native_speech_deliveries
  FOR DELETE
  USING ("companyId" = current_setting('app.current_company_id', true));

CREATE POLICY realtime_native_speech_delivery_delete_retention_fence
  ON public.realtime_native_speech_deliveries
  AS RESTRICTIVE
  FOR DELETE
  USING (
    phase IN ('delivered', 'cancelled', 'failed', 'expired')
    AND "retentionExpiresAt" <= statement_timestamp()
    AND NOT EXISTS (
      SELECT 1
        FROM public.realtime_control_grants AS control_grant
       WHERE control_grant."companyId" = realtime_native_speech_deliveries."companyId"
         AND control_grant."nativeDeliveryId" = realtime_native_speech_deliveries."deliveryId"
    )
  );

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_native_delivery_delete_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.deny_realtime_native_delivery_truncate_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID) FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID) FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID) FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_native_speech_maintenance_cursors FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.guard_realtime_native_delivery_delete_v1() IS
  'Défense DB de rétention native: tenant exact, terminal échu, aucune grant dépendante.';
COMMENT ON FUNCTION public.list_realtime_native_speech_maintenance_tenants_v1(TEXT, INTEGER, UUID) IS
  'Claim keyset distribué et borné des preuves natives dues; retourne uniquement les tenants.';
COMMENT ON FUNCTION public.ack_realtime_native_speech_maintenance_tenants_v1(TEXT, UUID) IS
  'ACK compare-and-set qui avance un claim de maintenance natif exactement une fois.';
COMMENT ON FUNCTION public.renew_realtime_native_speech_maintenance_claim_v1(TEXT, UUID) IS
  'Heartbeat compare-and-set d un claim natif avant chaque transaction tenantée bornée.';
COMMENT ON TABLE public.realtime_native_speech_maintenance_cursors IS
  'Curseurs techniques sans payload du scan keyset distribué de maintenance native.';

COMMIT;
