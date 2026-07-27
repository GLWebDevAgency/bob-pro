-- Bob AgentMission M1-B — binding append-only du matériau HMAC et plage monotone des writers.
--
-- Une version numérique seule ne prouve pas que le même secret est encore configuré. Le registre
-- grave donc une empreinte SHA-256 domain-separated des 32 octets exacts. Le secret ne quitte
-- jamais le secret store ; le runtime n'obtient aucun SELECT direct sur ces autorités globales.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.agent_mission_fingerprint_key_version_floors (
  "keySpace" VARCHAR(64) NOT NULL,
  "minimumWriterVersion" INTEGER NOT NULL,
  "highestWriterVersion" INTEGER NOT NULL,
  "writerEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT agent_mission_fingerprint_key_floor_pkey
    PRIMARY KEY ("keySpace"),
  CONSTRAINT agent_mission_fingerprint_key_floor_space_check
    CHECK ("keySpace" = 'bob-agent-mission-fingerprint-hmac-v1'),
  CONSTRAINT agent_mission_fingerprint_key_floor_value_check
    CHECK (
      "minimumWriterVersion" BETWEEN 1 AND 2147483647
      AND "highestWriterVersion"
        BETWEEN "minimumWriterVersion" AND 2147483647
      AND "highestWriterVersion"::BIGINT
        <= "minimumWriterVersion"::BIGINT + 1
      AND "updatedAt" >= "createdAt"
    )
);

CREATE TABLE public.agent_mission_fingerprint_key_bindings (
  "keyVersion" INTEGER NOT NULL,
  "keyFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT agent_mission_fingerprint_key_binding_pkey
    PRIMARY KEY ("keyVersion"),
  CONSTRAINT agent_mission_fingerprint_key_binding_fingerprint_key
    UNIQUE ("keyFingerprint"),
  CONSTRAINT agent_mission_fingerprint_key_binding_value_check
    CHECK (
      "keyVersion" BETWEEN 1 AND 2147483647
      AND "keyFingerprint"::TEXT ~ '^[a-f0-9]{64}$'
  )
);

-- La readiness de boot ne doit jamais trier/scanner tout le journal. L'index correspondant est
-- créé juste après les migrations par agent-mission-fingerprint-readiness-authority-provision.sql,
-- sous le propriétaire exact de agent_mission_events. Le déployeur Supabase n'est pas
-- nécessairement propriétaire de cette table et ne doit pas recevoir un privilège élargi pour
-- contourner cette frontière.

REVOKE ALL PRIVILEGES
  ON TABLE public.agent_mission_fingerprint_key_version_floors
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON TABLE public.agent_mission_fingerprint_key_bindings
  FROM PUBLIC;

DO $agent_mission_fingerprint_key_data_api_fence$
DECLARE
  exposed_role_name TEXT;
BEGIN
  FOREACH exposed_role_name IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_fingerprint_key_version_floors FROM %I',
        exposed_role_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_fingerprint_key_bindings FROM %I',
        exposed_role_name
      );
    END IF;
  END LOOP;
END;
$agent_mission_fingerprint_key_data_api_fence$;

ALTER TABLE public.agent_mission_fingerprint_key_version_floors
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_fingerprint_key_version_floors
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_fingerprint_key_bindings
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_fingerprint_key_bindings
  FORCE ROW LEVEL SECURITY;

-- CURRENT_USER est résolu en OID à la création. Seul le déployeur DIRECT_URL qui applique cette
-- migration peut stage/retire puis relire ; le rôle runtime ne reçoit aucune policy directe.
CREATE POLICY agent_mission_fingerprint_key_floor_direct_select
  ON public.agent_mission_fingerprint_key_version_floors
  FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY agent_mission_fingerprint_key_floor_direct_insert
  ON public.agent_mission_fingerprint_key_version_floors
  FOR INSERT TO CURRENT_USER WITH CHECK (true);
CREATE POLICY agent_mission_fingerprint_key_floor_direct_update
  ON public.agent_mission_fingerprint_key_version_floors
  FOR UPDATE TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY agent_mission_fingerprint_key_binding_direct_select
  ON public.agent_mission_fingerprint_key_bindings
  FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY agent_mission_fingerprint_key_binding_direct_insert
  ON public.agent_mission_fingerprint_key_bindings
  FOR INSERT TO CURRENT_USER WITH CHECK (true);

CREATE FUNCTION public.guard_agent_mission_fingerprint_key_floor_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $agent_mission_fingerprint_key_floor$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bob-agent-mission-fingerprint-hmac-v1', 0)
  );
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_mission_fingerprint_key_floor_append_only';
  END IF;
  IF TG_OP = 'INSERT' AND NOT NEW."writerEnabled" THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_INITIAL_STATE_INVALID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_mission_fingerprint_key_floor_initial_state';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."keySpace" IS DISTINCT FROM OLD."keySpace"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."minimumWriterVersion" < OLD."minimumWriterVersion"
       OR NEW."highestWriterVersion" < OLD."highestWriterVersion" THEN
      RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_ROLLBACK'
        USING ERRCODE = '23514',
              CONSTRAINT = 'agent_mission_fingerprint_key_floor_monotone';
    END IF;
    IF NEW."minimumWriterVersion" = OLD."minimumWriterVersion"
       AND NEW."highestWriterVersion" = OLD."highestWriterVersion"
       AND NEW."writerEnabled" = OLD."writerEnabled" THEN
      NEW."updatedAt" := OLD."updatedAt";
    ELSIF NEW."minimumWriterVersion" = OLD."minimumWriterVersion"
          AND NEW."highestWriterVersion" = OLD."highestWriterVersion"
          AND NEW."writerEnabled" IS DISTINCT FROM OLD."writerEnabled" THEN
      NEW."updatedAt" := GREATEST(
        pg_catalog.clock_timestamp(),
        OLD."updatedAt" + INTERVAL '1 microsecond'
      );
    ELSIF OLD."minimumWriterVersion" = OLD."highestWriterVersion"
          AND NEW."minimumWriterVersion" = OLD."minimumWriterVersion"
          AND NEW."highestWriterVersion"::BIGINT
            = OLD."highestWriterVersion"::BIGINT + 1 THEN
      IF NOT OLD."writerEnabled" OR NOT NEW."writerEnabled" THEN
        RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_DISABLED_TRANSITION'
          USING ERRCODE = '23514',
                CONSTRAINT = 'agent_mission_fingerprint_key_floor_transition';
      END IF;
      NEW."updatedAt" := GREATEST(
        pg_catalog.clock_timestamp(),
        OLD."updatedAt" + INTERVAL '1 microsecond'
      );
    ELSIF OLD."highestWriterVersion"::BIGINT
            = OLD."minimumWriterVersion"::BIGINT + 1
          AND NEW."minimumWriterVersion" = OLD."highestWriterVersion"
          AND NEW."highestWriterVersion" = OLD."highestWriterVersion" THEN
      IF NOT OLD."writerEnabled" OR NOT NEW."writerEnabled" THEN
        RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_DISABLED_TRANSITION'
          USING ERRCODE = '23514',
                CONSTRAINT = 'agent_mission_fingerprint_key_floor_transition';
      END IF;
      NEW."updatedAt" := GREATEST(
        pg_catalog.clock_timestamp(),
        OLD."updatedAt" + INTERVAL '1 microsecond'
      );
    ELSE
      RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_TRANSITION_INVALID'
        USING ERRCODE = '23514',
              CONSTRAINT = 'agent_mission_fingerprint_key_floor_transition';
    END IF;
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM public.agent_mission_fingerprint_key_bindings AS binding
        WHERE binding."keyVersion" = NEW."minimumWriterVersion"
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.agent_mission_fingerprint_key_bindings AS binding
        WHERE binding."keyVersion" = NEW."highestWriterVersion"
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_FLOOR_UNBOUND'
      USING ERRCODE = '55000',
            CONSTRAINT = 'agent_mission_fingerprint_key_floor_binding_required';
  END IF;
  RETURN NEW;
END;
$agent_mission_fingerprint_key_floor$;

CREATE TRIGGER agent_mission_fingerprint_key_floor_guard_v1
BEFORE INSERT OR UPDATE OR DELETE
ON public.agent_mission_fingerprint_key_version_floors
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_mission_fingerprint_key_floor_v1();
CREATE TRIGGER agent_mission_fingerprint_key_floor_truncate_guard_v1
BEFORE TRUNCATE
ON public.agent_mission_fingerprint_key_version_floors
FOR EACH STATEMENT
EXECUTE FUNCTION public.guard_agent_mission_fingerprint_key_floor_v1();

CREATE FUNCTION public.guard_agent_mission_fingerprint_key_binding_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $agent_mission_fingerprint_key_binding_immutable$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bob-agent-mission-fingerprint-hmac-v1', 0)
  );
  RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_BINDING_APPEND_ONLY'
    USING ERRCODE = '23514',
          CONSTRAINT = 'agent_mission_fingerprint_key_binding_append_only';
END;
$agent_mission_fingerprint_key_binding_immutable$;

CREATE TRIGGER agent_mission_fingerprint_key_binding_immutable_v1
BEFORE UPDATE OR DELETE OR TRUNCATE
ON public.agent_mission_fingerprint_key_bindings
FOR EACH STATEMENT
EXECUTE FUNCTION public.guard_agent_mission_fingerprint_key_binding_immutable_v1();

-- Cette fonction est transférée post-migration au rôle NOLOGIN de readiness. Tant que le floor
-- n'existe pas, elle préserve exactement le writer N-1. Le stage exclusif relit ensuite tous les
-- events : un writer concurrent committe avant ce snapshot ou attend le floor nouvellement armé.
CREATE FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $agent_mission_fingerprint_key_binding_present$
DECLARE
  minimum_writer_version INTEGER;
  highest_writer_version INTEGER;
  writer_enabled BOOLEAN;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('bob-agent-mission-fingerprint-hmac-v1', 0)
  );
  SELECT floor."minimumWriterVersion",
         floor."highestWriterVersion",
         floor."writerEnabled"
    INTO minimum_writer_version, highest_writer_version, writer_enabled
    FROM public.agent_mission_fingerprint_key_version_floors AS floor
   WHERE floor."keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NOT writer_enabled THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_WRITER_DISABLED'
      USING ERRCODE = '55000',
            CONSTRAINT = 'agent_mission_fingerprint_key_writer_disabled';
  END IF;
  IF NEW."fingerprintKeyVersion" < minimum_writer_version
     OR NEW."fingerprintKeyVersion" > highest_writer_version THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_VERSION_NOT_ADMITTED'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_mission_fingerprint_key_writer_range';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.agent_mission_fingerprint_key_bindings AS binding
     WHERE binding."keyVersion" = NEW."fingerprintKeyVersion"
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_VERSION_UNBOUND'
      USING ERRCODE = '55000',
            CONSTRAINT = 'agent_mission_fingerprint_key_binding_required';
  END IF;
  RETURN NEW;
END;
$agent_mission_fingerprint_key_binding_present$;

-- Le trigger sur agent_mission_events est créé par le provisionneur post-migration sous SET ROLE
-- du propriétaire exact de la table. Sur Supabase, le déployeur non-superuser ne possède plus
-- nécessairement cette table après les transferts d'ownership historiques.

-- L'entrée est bornée à 32 versions canoniques ; la sortie contient leur binding et au plus
-- 33 versions retenues. La 33e est un sentinel de dérive. Le floor nul est visible avant stage.
CREATE FUNCTION public.agent_mission_fingerprint_key_readiness(
  "configuredVersions" INTEGER[]
)
RETURNS TABLE (
  "keyVersion" INTEGER,
  "keyFingerprint" TEXT,
  retained BOOLEAN,
  "minimumWriterVersion" INTEGER,
  "highestWriterVersion" INTEGER,
  "writerEnabled" BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $agent_mission_fingerprint_key_readiness$
BEGIN
  IF "configuredVersions" IS NULL
     OR pg_catalog.cardinality("configuredVersions") < 1
     OR pg_catalog.cardinality("configuredVersions") > 32
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest("configuredVersions") AS configured(version)
        WHERE configured.version IS NULL
           OR configured.version < 1
           OR configured.version > 2147483647
     )
     OR (
       SELECT pg_catalog.count(DISTINCT configured.version)
         FROM pg_catalog.unnest("configuredVersions") AS configured(version)
     ) <> pg_catalog.cardinality("configuredVersions") THEN
    RAISE EXCEPTION 'AGENT_MISSION_FINGERPRINT_KEY_VERSIONS_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('bob-agent-mission-fingerprint-hmac-v1', 0)
  );

  RETURN QUERY
  WITH RECURSIVE configured_versions AS (
    SELECT configured.version
      FROM pg_catalog.unnest("configuredVersions") AS configured(version)
  ), retained_versions(version, ordinal) AS (
    (
      SELECT event."fingerprintKeyVersion", 1
        FROM public.agent_mission_events AS event
       ORDER BY event."fingerprintKeyVersion"
       LIMIT 1
    )
    UNION ALL
    SELECT next_version.version, retained.ordinal + 1
      FROM retained_versions AS retained
     CROSS JOIN LATERAL (
       SELECT event."fingerprintKeyVersion" AS version
         FROM public.agent_mission_events AS event
        WHERE event."fingerprintKeyVersion" > retained.version
        ORDER BY event."fingerprintKeyVersion"
        LIMIT 1
     ) AS next_version
     WHERE retained.ordinal < 33
  ), required_versions AS (
    SELECT required.version, pg_catalog.bool_or(required.is_retained) AS is_retained
      FROM (
        SELECT configured.version, false AS is_retained
          FROM configured_versions AS configured
        UNION ALL
        SELECT retained_version.version, true AS is_retained
          FROM retained_versions AS retained_version
      ) AS required
     GROUP BY required.version
  )
  SELECT required.version AS "keyVersion",
         binding."keyFingerprint"::TEXT AS "keyFingerprint",
         required.is_retained AS retained,
         floor."minimumWriterVersion",
         floor."highestWriterVersion",
         floor."writerEnabled"
    FROM required_versions AS required
    LEFT JOIN public.agent_mission_fingerprint_key_version_floors AS floor
      ON floor."keySpace" = 'bob-agent-mission-fingerprint-hmac-v1'
    LEFT JOIN public.agent_mission_fingerprint_key_bindings AS binding
      ON binding."keyVersion" = required.version
   ORDER BY required.version;
END;
$agent_mission_fingerprint_key_readiness$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_agent_mission_fingerprint_key_floor_v1()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_immutable_v1()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  FROM PUBLIC;

DO $agent_mission_fingerprint_key_function_data_api_fence$
DECLARE
  exposed_role_name TEXT;
BEGIN
  FOREACH exposed_role_name IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_fingerprint_key_floor_v1() FROM %I',
        exposed_role_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_immutable_v1() FROM %I',
        exposed_role_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1() FROM %I',
        exposed_role_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[]) FROM %I',
        exposed_role_name
      );
    END IF;
  END LOOP;
END;
$agent_mission_fingerprint_key_function_data_api_fence$;

COMMENT ON TABLE public.agent_mission_fingerprint_key_version_floors IS
  'Plage monotone de une ou deux versions autorisées à écrire des events AgentMission.';
COMMENT ON TABLE public.agent_mission_fingerprint_key_bindings IS
  'Engagement SHA-256 non secret, global et append-only du matériau HMAC AgentMission.';
COMMENT ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[]) IS
  'Readiness bornée des bindings, du floor writer et des versions retenues par le journal.';
COMMIT;
