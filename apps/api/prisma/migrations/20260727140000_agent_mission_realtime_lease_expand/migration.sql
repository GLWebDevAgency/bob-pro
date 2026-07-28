-- Bob AgentMission M1-B — capability Realtime expand-first.
-- Les quatre colonnes nullable conservent le contrat exact du writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_session_leases
  ADD COLUMN "agentMissionProtocolVersion" INTEGER,
  ADD COLUMN "agentMissionProtocolBoundAt" TIMESTAMPTZ(6),
  ADD COLUMN "agentMissionCapabilityHash" CHAR(64),
  ADD COLUMN "agentMissionReleaseFlagVersion" INTEGER;

ALTER TABLE public.realtime_session_leases
  ADD CONSTRAINT realtime_session_leases_agent_mission_capability_shape_check
  CHECK ((
    ("agentMissionProtocolVersion" IS NULL)
      = ("agentMissionProtocolBoundAt" IS NULL)
    AND ("agentMissionProtocolVersion" IS NULL)
      = ("agentMissionCapabilityHash" IS NULL)
    AND ("agentMissionProtocolVersion" IS NULL)
      = ("agentMissionReleaseFlagVersion" IS NULL)
    AND (
      "agentMissionProtocolVersion" IS NULL
      OR (
        "agentMissionProtocolVersion" IN (
          -- BEGIN GENERATED AGENT_MISSION_PROTOCOL_VERSIONS
          1
          -- END GENERATED AGENT_MISSION_PROTOCOL_VERSIONS
        )
        AND pg_catalog.isfinite("agentMissionProtocolBoundAt")
        AND "agentMissionProtocolBoundAt" = "reservedAt"
        AND "agentMissionCapabilityHash" ~ '^[a-f0-9]{64}$'
        AND "agentMissionReleaseFlagVersion" BETWEEN 1 AND 2147483647
      )
    )
  ) IS TRUE)
  NOT VALID;

-- Le binding est une preuve figée dans l'INSERT d'admission. Un writer historique ne peut pas
-- promouvoir après coup une lease NULL, et aucun runtime ne peut remplacer une capability V1.
CREATE FUNCTION public.guard_realtime_agent_mission_capability_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $agent_mission_capability_immutable$
BEGIN
  IF ROW(
    NEW."agentMissionProtocolVersion",
    NEW."agentMissionProtocolBoundAt",
    NEW."agentMissionCapabilityHash",
    NEW."agentMissionReleaseFlagVersion"
  ) IS DISTINCT FROM ROW(
    OLD."agentMissionProtocolVersion",
    OLD."agentMissionProtocolBoundAt",
    OLD."agentMissionCapabilityHash",
    OLD."agentMissionReleaseFlagVersion"
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_CAPABILITY_BINDING_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$agent_mission_capability_immutable$;

REVOKE ALL ON FUNCTION public.guard_realtime_agent_mission_capability_immutable_v1()
  FROM PUBLIC;

CREATE TRIGGER realtime_session_lease_agent_mission_capability_immutable_v1
BEFORE UPDATE OF
  "agentMissionProtocolVersion",
  "agentMissionProtocolBoundAt",
  "agentMissionCapabilityHash",
  "agentMissionReleaseFlagVersion"
ON public.realtime_session_leases
FOR EACH ROW
EXECUTE FUNCTION public.guard_realtime_agent_mission_capability_immutable_v1();

COMMENT ON COLUMN public.realtime_session_leases."agentMissionProtocolVersion" IS
  'Version AgentMission négociée pendant reserve ; NULL pour tout writer historique.';
COMMENT ON COLUMN public.realtime_session_leases."agentMissionProtocolBoundAt" IS
  'Horloge DB autoritaire, strictement identique à reservedAt.';
COMMENT ON COLUMN public.realtime_session_leases."agentMissionCapabilityHash" IS
  'SHA-256 hex de la capability bam1 ; le secret brut ne doit jamais être persisté.';
COMMENT ON COLUMN public.realtime_session_leases."agentMissionReleaseFlagVersion" IS
  'Version de la ligne parente release flag verrouillée pendant admission.';

-- Les nouvelles colonnes d'une table existante héritent des GRANT table-level. Les rôles Data API
-- Supabase restent explicitement privés, y compris face à d'anciens ACL de colonnes.
REVOKE ALL PRIVILEGES ON TABLE public.realtime_session_leases FROM PUBLIC;

DO $agent_mission_lease_data_api_fence$
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
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_agent_mission_capability_immutable_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$agent_mission_lease_data_api_fence$;

COMMIT;
