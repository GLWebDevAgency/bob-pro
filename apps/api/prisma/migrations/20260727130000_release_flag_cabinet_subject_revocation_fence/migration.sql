-- Bob AgentMission M1-B — autorité release flag versionnée et révocation cabinet.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Le flag existe partout mais reste fermé. Une activation relève exclusivement du protocole ops.
INSERT INTO public.release_flags (
  id,
  key,
  environment,
  enabled,
  "killSwitch",
  version,
  "updatedByUserId",
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'bob-agent-missions-quote-v1-development',
    'bob.agent_missions.quote.v1',
    'development',
    false,
    false,
    1,
    'system:migration',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'bob-agent-missions-quote-v1-staging',
    'bob.agent_missions.quote.v1',
    'staging',
    false,
    false,
    1,
    'system:migration',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'bob-agent-missions-quote-v1-production',
    'bob.agent_missions.quote.v1',
    'production',
    false,
    false,
    1,
    'system:migration',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

-- La lecture préliminaire domaine ne suffit jamais à autoriser. Cette fonction ne révèle aucune
-- donnée du flag ; elle verrouille seulement la version parente immédiatement avant l'admission.
CREATE OR REPLACE FUNCTION public.revalidate_agent_mission_release_flag_v1(
  p_key TEXT,
  p_environment TEXT,
  p_expected_version INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '3s'
AS $$
DECLARE
  matched BOOLEAN;
BEGIN
  IF p_key IS NULL
     OR p_key !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
     OR length(p_key) > 80
     OR p_environment NOT IN ('development', 'staging', 'production')
     OR p_expected_version IS NULL
     OR p_expected_version < 1 THEN
    RETURN FALSE;
  END IF;

  SELECT TRUE
    INTO matched
    FROM public.release_flags AS flag
   WHERE flag.key = p_key
     AND flag.environment::TEXT = p_environment
     AND flag.version = p_expected_version
     AND NOT flag."killSwitch"
   FOR SHARE OF flag;

  RETURN COALESCE(matched, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.revalidate_agent_mission_release_flag_v1(
  TEXT,
  TEXT,
  INTEGER
) FROM PUBLIC;

DO $agent_mission_data_api_fence$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.revalidate_agent_mission_release_flag_v1(TEXT, TEXT, INTEGER) FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$agent_mission_data_api_fence$;

-- La suppression RGPD d'un cabinet est aussi une mutation d'override : parent verrouillé,
-- version incrémentée et audit append-only, sans contourner l'invalidation d'une admission.
CREATE OR REPLACE FUNCTION public.cabinet_delete_release_flag_subjects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  target RECORD;
  next_flag_version INTEGER;
BEGIN
  FOR target IN
    SELECT subject.id AS subject_id,
           subject."flagId" AS flag_id,
           subject."subjectType" AS subject_type,
           subject."subjectId" AS subject_identifier,
           subject.enabled AS subject_enabled,
           subject.version AS subject_version,
           flag.version AS flag_version
      FROM public.release_flag_subjects AS subject
      JOIN public.release_flags AS flag ON flag.id = subject."flagId"
     WHERE subject."subjectType" = 'cabinet'
       AND subject."subjectId" = OLD.id
     ORDER BY flag.id, subject.id
     FOR UPDATE OF flag, subject
  LOOP
    UPDATE public.release_flags
       SET version = version + 1,
           "updatedByUserId" = 'system:cabinet-delete',
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE id = target.flag_id
       AND version = target.flag_version
     RETURNING version INTO STRICT next_flag_version;

    DELETE FROM public.release_flag_subjects
     WHERE id = target.subject_id
       AND "flagId" = target.flag_id;

    INSERT INTO public.release_flag_audit_events (
      id,
      "flagId",
      actor,
      reason,
      operation,
      "beforeState",
      "afterState",
      "createdAt"
    )
    VALUES (
      pg_catalog.format(
        'cabinet-delete:%s:%s:%s',
        target.flag_id,
        OLD.id,
        next_flag_version
      ),
      target.flag_id,
      'system:cabinet-delete',
      'Suppression RGPD du cabinet et de son ciblage release flag',
      'remove-subject',
      pg_catalog.jsonb_build_object(
        'exists', TRUE,
        'subjectType', target.subject_type,
        'subjectId', target.subject_identifier,
        'enabled', target.subject_enabled,
        'version', target.subject_version,
        'flagVersion', target.flag_version
      ),
      pg_catalog.jsonb_build_object(
        'exists', FALSE,
        'subjectType', target.subject_type,
        'subjectId', target.subject_identifier,
        'flagVersion', next_flag_version
      ),
      CURRENT_TIMESTAMP
    );
  END LOOP;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.cabinet_delete_release_flag_subjects() FROM PUBLIC;

DO $cabinet_delete_data_api_fence$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.cabinet_delete_release_flag_subjects() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$cabinet_delete_data_api_fence$;

COMMIT;
