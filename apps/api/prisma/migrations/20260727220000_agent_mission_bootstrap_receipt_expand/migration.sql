-- Bob AgentMission M1-B — reçu durable du bootstrap V1, expand-first.
-- La colonne nullable conserve le writer N-1 exact et ne confère aucune autorité par défaut.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_session_leases
  ADD COLUMN "agentMissionBootstrapAcknowledgedAt" TIMESTAMPTZ(6);

ALTER TABLE public.realtime_session_leases
  ADD CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_check
  CHECK ((
    "agentMissionBootstrapAcknowledgedAt" IS NULL
    OR (
      "agentMissionProtocolVersion" = 1
      AND "agentMissionProtocolBoundAt" IS NOT NULL
      AND "agentMissionCapabilityHash" IS NOT NULL
      AND pg_catalog.isfinite("agentMissionBootstrapAcknowledgedAt")
      AND "agentMissionBootstrapAcknowledgedAt" >= "agentMissionProtocolBoundAt"
      AND "agentMissionBootstrapAcknowledgedAt" <= "hardExpiresAt"
    )
  ) IS TRUE)
  NOT VALID;

-- Le reçu ne peut jamais être prérempli pendant INSERT. Son unique transition autorisée est
-- NULL -> horloge DB, sur une lease V1 déjà liée ; remplacement et effacement sont interdits.
CREATE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $agent_mission_bootstrap_receipt$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."agentMissionBootstrapAcknowledgedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_INSERT_FORBIDDEN'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."agentMissionBootstrapAcknowledgedAt"
       IS NOT DISTINCT FROM OLD."agentMissionBootstrapAcknowledgedAt" THEN
    RETURN NEW;
  END IF;

  IF OLD."agentMissionBootstrapAcknowledgedAt" IS NOT NULL
     OR NEW."agentMissionBootstrapAcknowledgedAt" IS NULL
     OR OLD."agentMissionProtocolVersion" IS DISTINCT FROM 1
     OR OLD."agentMissionProtocolBoundAt" IS NULL
     OR OLD."agentMissionCapabilityHash" IS NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;

  NEW."agentMissionBootstrapAcknowledgedAt" := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$agent_mission_bootstrap_receipt$;

REVOKE ALL ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1()
  FROM PUBLIC;

CREATE TRIGGER realtime_lease_agent_mission_receipt_insert_v1
BEFORE INSERT ON public.realtime_session_leases
FOR EACH ROW
EXECUTE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1();

CREATE TRIGGER realtime_lease_agent_mission_receipt_update_v1
BEFORE UPDATE OF "agentMissionBootstrapAcknowledgedAt"
ON public.realtime_session_leases
FOR EACH ROW
EXECUTE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1();

COMMENT ON COLUMN public.realtime_session_leases."agentMissionBootstrapAcknowledgedAt" IS
  'Reçu applicatif one-shot du secret V1 ; NULL interdit toute autorité AgentMission.';

REVOKE ALL PRIVILEGES ON TABLE public.realtime_session_leases FROM PUBLIC;

DO $agent_mission_bootstrap_receipt_data_api_fence$
DECLARE
  exposed_role TEXT;
  column_name TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_session_leases FROM %I',
        exposed_role
      );
      FOR column_name IN
        SELECT attribute.attname
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.realtime_session_leases'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attacl IS NOT NULL
         ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.realtime_session_leases FROM %I',
          column_name,
          column_name,
          column_name,
          column_name,
          exposed_role
        );
      END LOOP;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$agent_mission_bootstrap_receipt_data_api_fence$;

COMMIT;
