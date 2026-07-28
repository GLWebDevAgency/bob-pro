#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;

const CLEAN_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true)
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  ),
  'draftCount', (
    SELECT count(*) FROM public.quote_draft_slots
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
  ),
  'tenantLeaseCount', (
    SELECT count(*) FROM public.realtime_session_leases
     WHERE "companyId" = :'company_id'
  )
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const RECOVERY_STATE_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true)
), candidate AS MATERIALIZED (
  SELECT
    mission.id AS "missionId",
    mission.revision AS "missionRevision",
    event."commandId" AS "startCommandId",
    draft.payload -> 'draft' ->> 'sessionId' AS "draftSessionId",
    draft.revision AS "draftSlotRevision",
    (draft.payload -> 'draft' ->> 'contentRevision')::integer
      AS "draftContentRevision",
    (
      mission.kind = 'quote_creation'
      AND mission.status = 'active'
      AND mission.phase = 'awaiting_quote_screen'
      AND mission.revision = 1
      AND mission."payloadVersion" = 1
      AND mission."currentBinding" IS NULL
      AND mission.payload @> '{"schema":"bob.agent-mission.quote-creation","version":1,"decision":null}'::jsonb
      AND mission.payload -> 'draft' ->> 'sessionId' =
        draft.payload -> 'draft' ->> 'sessionId'
      AND (mission.payload -> 'draft' ->> 'slotRevision')::integer = draft.revision
      AND (mission.payload -> 'draft' ->> 'contentRevision')::integer =
        (draft.payload -> 'draft' ->> 'contentRevision')::integer
      AND event.sequence = 1
      AND event."eventType" = 'mission_started'
      AND event.actor = 'user_tap'
      AND event."missionRevisionBefore" = 0
      AND event."missionRevisionAfter" = 1
      AND event."draftSlotRevisionBefore" IS NULL
      AND event."draftSlotRevisionAfter" = 1
      AND event."draftContentRevisionBefore" IS NULL
      AND event."draftContentRevisionAfter" = 0
      AND event.data = '{"kind":"mission_started","startOutcome":"no_slot"}'::jsonb
      AND draft."agentMissionId" = mission.id
      AND draft.revision = 1
      AND draft."payloadVersion" = 1
      AND (draft.payload -> 'draft' ->> 'contentRevision')::integer = 0
    ) AS matches
  FROM public.agent_missions AS mission
  JOIN public.agent_mission_events AS event
    ON event."missionId" = mission.id
   AND event."companyId" = mission."companyId"
   AND event."ownerUserId" = mission."ownerUserId"
  JOIN public.quote_draft_slots AS draft
    ON draft."companyId" = mission."companyId"
   AND draft."ownerUserId" = mission."ownerUserId"
  WHERE mission."companyId" = :'company_id'
    AND mission."ownerUserId" = :'user_id'
    AND mission.kind = 'quote_creation'
    AND mission.status = 'active'
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  ),
  'missionEventCount', (
    SELECT count(*) FROM public.agent_mission_events
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND "missionId" = (SELECT "missionId" FROM candidate LIMIT 1)
  ),
  'draftCount', (
    SELECT count(*) FROM public.quote_draft_slots
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
  ),
  'tenantLeaseCount', (
    SELECT count(*) FROM public.realtime_session_leases
     WHERE "companyId" = :'company_id'
  ),
  'candidateCount', (SELECT count(*) FROM candidate),
  'candidateMatches', coalesce((SELECT bool_and(matches) FROM candidate), false),
  'missionId', (SELECT "missionId"::text FROM candidate),
  'missionRevision', (SELECT "missionRevision" FROM candidate),
  'startCommandId', (SELECT "startCommandId"::text FROM candidate),
  'draftSessionId', (SELECT "draftSessionId" FROM candidate),
  'draftSlotRevision', (SELECT "draftSlotRevision" FROM candidate),
  'draftContentRevision', (SELECT "draftContentRevision" FROM candidate)
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const RECOVERY_TERMINAL_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true),
    set_config('app.current_agent_mission_id', :'mission_id', true)
), terminal AS MATERIALIZED (
  SELECT
    mission.id AS "missionId",
    mission.status AS "terminalStatus",
    mission.revision AS "missionRevision",
    mission."terminalAt",
    (
      mission.kind = 'quote_creation'
      AND mission.status IN ('cancelled', 'expired')
      AND mission.phase = 'awaiting_quote_screen'
      AND mission.revision = 2
      AND mission."currentBinding" IS NULL
      AND mission."terminalAt" IS NOT NULL
      AND start_event.sequence = 1
      AND start_event."eventType" = 'mission_started'
      AND start_event."commandId" = :'start_command_id'::uuid
      AND start_event.data =
        '{"kind":"mission_started","startOutcome":"no_slot"}'::jsonb
      AND terminal_event.sequence = 2
      AND (
        (
          mission.status = 'cancelled'
          AND terminal_event."eventType" = 'mission_cancelled'
          AND terminal_event.actor = 'user_tap'
          AND terminal_event."commandId" = :'cancel_command_id'::uuid
          AND terminal_event.data =
            '{"kind":"mission_cancelled","reason":"user_cancelled"}'::jsonb
        )
        OR (
          mission.status = 'expired'
          AND terminal_event."eventType" = 'mission_expired'
          AND terminal_event.actor = 'system'
          AND terminal_event.data ->> 'kind' = 'mission_expired'
          AND terminal_event.data ->> 'reason' IN ('idle_ttl', 'hard_ttl')
        )
      )
      AND draft."agentMissionId" IS NULL
      AND draft.revision = :'draft_slot_revision'::integer
      AND draft.payload -> 'draft' ->> 'sessionId' = :'draft_session_id'
      AND (draft.payload -> 'draft' ->> 'contentRevision')::integer =
        :'draft_content_revision'::integer
    ) AS matches
  FROM public.agent_missions AS mission
  JOIN public.agent_mission_events AS start_event
    ON start_event."missionId" = mission.id
   AND start_event."companyId" = mission."companyId"
   AND start_event."ownerUserId" = mission."ownerUserId"
   AND start_event.sequence = 1
  JOIN public.agent_mission_events AS terminal_event
    ON terminal_event."missionId" = mission.id
   AND terminal_event."companyId" = mission."companyId"
   AND terminal_event."ownerUserId" = mission."ownerUserId"
   AND terminal_event.sequence = 2
  JOIN public.quote_draft_slots AS draft
    ON draft."companyId" = mission."companyId"
   AND draft."ownerUserId" = mission."ownerUserId"
  WHERE mission.id = :'mission_id'::uuid
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'terminalCount', (SELECT count(*) FROM terminal),
  'terminalMatches', coalesce((SELECT bool_and(matches) FROM terminal), false),
  'missionEventCount', (
    SELECT count(*) FROM public.agent_mission_events
     WHERE "missionId" = :'mission_id'::uuid
  ),
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  ),
  'missionId', (SELECT "missionId"::text FROM terminal),
  'terminalStatus', (SELECT "terminalStatus" FROM terminal),
  'missionRevision', (SELECT "missionRevision" FROM terminal),
  'terminalAt', (SELECT "terminalAt" FROM terminal)
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const START_RECOVERY_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true)
), recovered AS MATERIALIZED (
  SELECT
    event."missionId",
    mission.revision AS "missionRevision",
    draft.payload -> 'draft' ->> 'sessionId' AS "draftSessionId",
    draft.revision AS "draftSlotRevision",
    (draft.payload -> 'draft' ->> 'contentRevision')::integer
      AS "draftContentRevision",
    (
      event."eventType" = 'mission_started'
      AND event.sequence = 1
      AND event.actor = 'user_tap'
      AND event."missionRevisionBefore" = 0
      AND event."missionRevisionAfter" = 1
      AND event."draftSlotRevisionAfter" = draft.revision
      AND event."draftContentRevisionAfter" =
        (draft.payload -> 'draft' ->> 'contentRevision')::integer
      AND event.data ->> 'kind' = 'mission_started'
      AND event.data ->> 'startOutcome' = 'no_slot'
      AND mission.kind = 'quote_creation'
      AND mission.status = 'active'
      AND mission.phase = 'awaiting_quote_screen'
      AND mission.revision = 1
      AND mission."currentBinding" IS NULL
      AND draft."agentMissionId" = mission.id
      AND draft.revision = 1
      AND (draft.payload -> 'draft' ->> 'contentRevision')::integer = 0
    ) AS matches
  FROM public.agent_mission_events AS event
  JOIN public.agent_missions AS mission
    ON mission.id = event."missionId"
   AND mission."companyId" = event."companyId"
   AND mission."ownerUserId" = event."ownerUserId"
  JOIN public.quote_draft_slots AS draft
    ON draft."companyId" = event."companyId"
   AND draft."ownerUserId" = event."ownerUserId"
  WHERE event."companyId" = :'company_id'
    AND event."ownerUserId" = :'user_id'
    AND event."commandId" = :'start_command_id'::uuid
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'recoveryCount', (SELECT count(*) FROM recovered),
  'recoveryMatches', coalesce((SELECT bool_and(matches) FROM recovered), false),
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  ),
  'draftCount', (
    SELECT count(*) FROM public.quote_draft_slots
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
  ),
  'missionId', (SELECT "missionId"::text FROM recovered),
  'missionRevision', (SELECT "missionRevision" FROM recovered),
  'draftSessionId', (SELECT "draftSessionId" FROM recovered),
  'draftSlotRevision', (SELECT "draftSlotRevision" FROM recovered),
  'draftContentRevision', (SELECT "draftContentRevision" FROM recovered)
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const CANCELLATION_RECOVERY_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true),
    set_config('app.current_agent_mission_id', :'mission_id', true)
), proof AS MATERIALIZED (
  SELECT
    mission.id,
    mission.revision,
    mission."terminalAt",
    (
      mission."companyId" = :'company_id'
      AND mission."ownerUserId" = :'user_id'
      AND mission.kind = 'quote_creation'
      AND mission.status = 'cancelled'
      AND mission.revision = :'mission_revision'::integer
      AND mission."terminalAt" IS NOT NULL
      AND start_event."eventType" = 'mission_started'
      AND start_event.sequence = 1
      AND cancel_event."eventType" = 'mission_cancelled'
      AND cancel_event.actor = 'user_tap'
      AND cancel_event."missionRevisionBefore" =
        :'expected_mission_revision'::integer
      AND cancel_event."missionRevisionAfter" =
        :'mission_revision'::integer
      AND draft."agentMissionId" IS NULL
      AND draft.payload -> 'draft' ->> 'sessionId' = :'draft_session_id'
      AND (draft.payload -> 'draft' ->> 'contentRevision')::integer =
        :'draft_content_revision'::integer
    ) AS matches
  FROM public.agent_missions AS mission
  JOIN public.agent_mission_events AS start_event
    ON start_event."missionId" = mission.id
   AND start_event."companyId" = mission."companyId"
   AND start_event."ownerUserId" = mission."ownerUserId"
   AND start_event."commandId" = :'start_command_id'::uuid
  JOIN public.agent_mission_events AS cancel_event
    ON cancel_event."missionId" = mission.id
   AND cancel_event."companyId" = mission."companyId"
   AND cancel_event."ownerUserId" = mission."ownerUserId"
   AND cancel_event."commandId" = :'cancel_command_id'::uuid
  JOIN public.quote_draft_slots AS draft
    ON draft."companyId" = mission."companyId"
   AND draft."ownerUserId" = mission."ownerUserId"
  WHERE mission.id = :'mission_id'::uuid
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'recoveryCount', (SELECT count(*) FROM proof),
  'recoveryMatches', coalesce((SELECT bool_and(matches) FROM proof), false),
  'missionId', (SELECT id::text FROM proof),
  'missionRevision', (SELECT revision FROM proof),
  'terminalAt', (SELECT "terminalAt" FROM proof)
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const ACTIVE_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true),
    set_config('app.current_agent_mission_id', :'mission_id', true)
), local_proof AS MATERIALIZED (
  SELECT jsonb_build_object(
    'roleMatches', current_user = :'app_role',
    'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
    'missionCount', (
      SELECT count(*) FROM public.agent_missions
       WHERE id = :'mission_id'::uuid
    ),
    'missionMatches', coalesce((
      SELECT
        mission."companyId" = :'company_id'
        AND mission."ownerUserId" = :'user_id'
        AND mission.kind = 'quote_creation'
        AND mission.status = 'active'
        AND mission.phase = 'awaiting_customer'
        AND mission.revision = :'mission_revision'::integer
        AND mission."currentBinding" ->> 'realtimeSessionId' = :'session_id'
        AND (mission."currentBinding" ->> 'contextRevision')::integer =
          :'context_revision'::integer
        AND mission."currentBinding" ->> 'contextDigest' = :'context_digest'
        AND mission."currentBinding" ->> 'screenName' = '/devis/new'
        AND mission."currentBinding" ->> 'screenInstanceId' = :'screen_instance_id'
      FROM public.agent_missions AS mission
      WHERE mission.id = :'mission_id'::uuid
    ), false),
    'eventCount', (
      SELECT count(*) FROM public.agent_mission_events
       WHERE "missionId" = :'mission_id'::uuid
    ),
    'eventsMatch', coalesce((
      SELECT
        array_agg(event."eventType" ORDER BY event.sequence) =
          ARRAY['mission_started', 'screen_acknowledged']::text[]
        AND array_agg(event."commandId"::text ORDER BY event.sequence) =
          ARRAY[:'start_command_id', :'ack_command_id']::text[]
        AND max(event."realtimeSessionId"::text) FILTER (
          WHERE event."eventType" = 'screen_acknowledged'
        ) = :'session_id'
        AND max(event."contextRevision") FILTER (
          WHERE event."eventType" = 'screen_acknowledged'
        ) = :'context_revision'::integer
        AND max(btrim(event."contextDigest")) FILTER (
          WHERE event."eventType" = 'screen_acknowledged'
        ) = :'context_digest'
      FROM public.agent_mission_events AS event
      WHERE event."missionId" = :'mission_id'::uuid
    ), false),
    'draftCount', (
      SELECT count(*) FROM public.quote_draft_slots
       WHERE "companyId" = :'company_id'
         AND "ownerUserId" = :'user_id'
    ),
    'draftMatches', coalesce((
      SELECT
        draft."agentMissionId" = :'mission_id'::uuid
        AND draft.revision = :'draft_slot_revision'::integer
        AND draft."payloadVersion" = 1
        AND draft.payload -> 'draft' ->> 'sessionId' = :'draft_session_id'
        AND (draft.payload -> 'draft' ->> 'contentRevision')::integer =
          :'draft_content_revision'::integer
      FROM public.quote_draft_slots AS draft
      WHERE draft."companyId" = :'company_id'
        AND draft."ownerUserId" = :'user_id'
    ), false),
    'leaseCount', (
      SELECT count(*) FROM public.realtime_session_leases
       WHERE "sessionId" = :'session_id'::uuid
    ),
    'leaseMatches', coalesce((
      SELECT
        lease."companyId" = :'company_id'
        AND lease.state = 'active'
        AND lease."agentMissionProtocolVersion" = 1
        AND lease."agentMissionBootstrapAcknowledgedAt" IS NOT NULL
        AND lease."contextSchemaVersion" = 1
        AND lease."contextRevision" = :'context_revision'::integer
        AND lease."contextAppliedRevision" = :'context_revision'::integer
        AND btrim(lease."contextDigest") = :'context_digest'
        AND btrim(lease."contextAppliedDigest") = :'context_digest'
        AND lease."contextPayload" -> 'screen' ->> 'name' = '/devis/new'
        AND lease."contextPayload" -> 'screen' ->> 'instanceId' = :'screen_instance_id'
        AND lease."agentMissionReleaseFlagVersion" = flag.version
        AND NOT flag.enabled
        AND NOT flag."killSwitch"
        AND target.enabled
      FROM public.realtime_session_leases AS lease
      JOIN public.release_flags AS flag
        ON flag.key = 'bob.agent_missions.quote.v1'
       AND flag.environment = 'staging'::public."ReleaseEnvironment"
      JOIN public.release_flag_subjects AS target
        ON target."flagId" = flag.id
       AND target."subjectType" = 'user'::public."ReleaseFlagSubjectType"
       AND target."subjectId" = :'user_id'
      WHERE lease."sessionId" = :'session_id'::uuid
    ), false)
  ) AS payload
  FROM configured
  JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user
), sentinel_config AS MATERIALIZED (
  SELECT
    local_proof.payload,
    set_config('app.current_company_id', :'sentinel_company_id', true),
    set_config('app.current_user_id', :'sentinel_user_id', true)
  FROM local_proof
), sentinel_proof AS MATERIALIZED (
  SELECT
    sentinel_config.payload,
    jsonb_build_object(
      'sentinelMissionCount', (
        SELECT count(*) FROM public.agent_missions
         WHERE id = :'mission_id'::uuid
      ),
      'sentinelEventCount', (
        SELECT count(*) FROM public.agent_mission_events
         WHERE "missionId" = :'mission_id'::uuid
      ),
      'sentinelDraftCount', (
        SELECT count(*) FROM public.quote_draft_slots
         WHERE "companyId" = :'company_id'
           AND "ownerUserId" = :'user_id'
      ),
      'sentinelLeaseCount', (
        SELECT count(*) FROM public.realtime_session_leases
         WHERE "sessionId" = :'session_id'::uuid
      )
    ) AS sentinel
  FROM sentinel_config
)
SELECT payload || sentinel FROM sentinel_proof;
ROLLBACK;
`;

const FINAL_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true),
    set_config('app.current_agent_mission_id', :'mission_id', true)
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'missionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE id = :'mission_id'::uuid
  ),
  'missionCancelled', coalesce((
    SELECT
      mission.status = 'cancelled'
      AND NOT (mission.status = 'active')
      AND mission.revision = :'mission_revision'::integer
      AND mission."terminalAt" IS NOT NULL
    FROM public.agent_missions AS mission
    WHERE mission.id = :'mission_id'::uuid
  ), false),
  'eventCount', (
    SELECT count(*) FROM public.agent_mission_events
     WHERE "missionId" = :'mission_id'::uuid
  ),
  'eventsMatch', coalesce((
    SELECT
      array_agg(event."eventType" ORDER BY event.sequence) =
        ARRAY['mission_started', 'screen_acknowledged', 'mission_cancelled']::text[]
      AND array_agg(event."commandId"::text ORDER BY event.sequence) =
        ARRAY[:'start_command_id', :'ack_command_id', :'cancel_command_id']::text[]
    FROM public.agent_mission_events AS event
    WHERE event."missionId" = :'mission_id'::uuid
  ), false),
  'draftCount', (
    SELECT count(*) FROM public.quote_draft_slots
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
  ),
  'leaseCount', (
    SELECT count(*) FROM public.realtime_session_leases
     WHERE "sessionId" = :'session_id'::uuid
  ),
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  )
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

const NEGATIVE_FINAL_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH configured AS MATERIALIZED (
  SELECT
    set_config('app.current_company_id', :'company_id', true),
    set_config('app.current_user_id', :'user_id', true)
)
SELECT jsonb_build_object(
  'roleMatches', current_user = :'app_role',
  'roleSafe', NOT role.rolsuper AND NOT role.rolbypassrls,
  'sessionLeaseCount', (
    SELECT count(*) FROM public.realtime_session_leases
     WHERE "sessionId" = :'session_id'::uuid
  ),
  'tenantLeaseCount', (
    SELECT count(*) FROM public.realtime_session_leases
     WHERE "companyId" = :'company_id'
  ),
  'activeMissionCount', (
    SELECT count(*) FROM public.agent_missions
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
       AND kind = 'quote_creation'
       AND status = 'active'
  ),
  'draftCount', (
    SELECT count(*) FROM public.quote_draft_slots
     WHERE "companyId" = :'company_id'
       AND "ownerUserId" = :'user_id'
  )
)
FROM configured
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user;
ROLLBACK;
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-evidence:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 8_192 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function canonicalUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('DATABASE_URL must use PostgreSQL');
  }
  return { value, user: decodeURIComponent(parsed.username) };
}

export function parseM1BStagingEvidenceEnvironment(environment = process.env) {
  const database = canonicalUrl(required(environment, 'DATABASE_URL'));
  const appRole = required(environment, 'APP_DATABASE_ROLE', { maximum: 63 });
  const projectRef = required(environment, 'BOB_M1B_STAGING_SUPABASE_PROJECT_REF', { maximum: 20 });
  if (
    !/^[a-z_][a-z0-9_-]{0,62}$/u.test(appRole) ||
    !/^[a-z0-9]{20}$/u.test(projectRef) ||
    (database.user !== appRole && database.user !== `${appRole}.${projectRef}`)
  ) {
    fail('DATABASE_URL must connect as APP_DATABASE_ROLE');
  }
  const companyId = required(environment, 'BOB_M1B_STAGING_COMPANY_ID', { maximum: 64 });
  const userId = required(environment, 'BOB_M1B_STAGING_USER_ID', { maximum: 80 });
  if (!IDENTIFIER.test(companyId)) fail('BOB_M1B_STAGING_COMPANY_ID is invalid');
  if (!UUID.test(userId)) fail('BOB_M1B_STAGING_USER_ID must be a UUID');
  return Object.freeze({
    databaseUrl: database.value,
    appRole,
    companyId,
    userId,
  });
}

function positiveRevision(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 2_147_483_647) {
    fail(`${name} is invalid`);
  }
  return String(value);
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${name} must be a UUID`);
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${name} is invalid`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${name} is invalid`);
  return value;
}

function baseVariables(config, input) {
  return {
    app_role: config.appRole,
    company_id: config.companyId,
    user_id: config.userId,
    mission_id: uuid(input.missionId, 'missionId'),
    session_id: uuid(input.sessionId, 'sessionId'),
    start_command_id: uuid(input.startCommandId, 'startCommandId'),
    ack_command_id: uuid(input.ackCommandId, 'ackCommandId'),
  };
}

function psql(config, sql, variables, environment, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) {
    args.push('-v', `${name}=${value}`);
  }
  const result = withPsqlChildEnvironment(config.databaseUrl, environment, (childEnvironment) =>
    spawn(
      'psql',
      args,
      boundedPsqlSpawnOptions(childEnvironment, {
        input: sql,
        encoding: 'utf8',
      }),
    ),
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(config.databaseUrl, '[redacted]')
      .trim();
    fail(`runtime database proof failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const rows = String(result.stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1) fail('runtime database proof returned an ambiguous result');
  try {
    return JSON.parse(rows[0]);
  } catch {
    fail('runtime database proof returned invalid JSON');
  }
}

function exactObject(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function decodeM1BActiveEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'missionCount',
    'missionMatches',
    'eventCount',
    'eventsMatch',
    'draftCount',
    'draftMatches',
    'leaseCount',
    'leaseMatches',
    'sentinelMissionCount',
    'sentinelEventCount',
    'sentinelDraftCount',
    'sentinelLeaseCount',
  ];
  if (!exactObject(value, keys)) fail('active proof shape is invalid');
  const passed =
    value.roleMatches === true &&
    value.roleSafe === true &&
    value.missionCount === 1 &&
    value.missionMatches === true &&
    value.eventCount === 2 &&
    value.eventsMatch === true &&
    value.draftCount === 1 &&
    value.draftMatches === true &&
    value.leaseCount === 1 &&
    value.leaseMatches === true &&
    value.sentinelMissionCount === 0 &&
    value.sentinelEventCount === 0 &&
    value.sentinelDraftCount === 0 &&
    value.sentinelLeaseCount === 0;
  if (!passed) fail('active runtime/RLS proof did not pass exactly');
  return Object.freeze({ stage: 'active', passed: true });
}

export function decodeM1BCleanEvidence(value) {
  const keys = ['roleMatches', 'roleSafe', 'activeMissionCount', 'draftCount', 'tenantLeaseCount'];
  if (!exactObject(value, keys)) fail('clean-account proof shape is invalid');
  const passed =
    value.roleMatches === true &&
    value.roleSafe === true &&
    value.activeMissionCount === 0 &&
    value.draftCount === 0 &&
    value.tenantLeaseCount === 0;
  if (!passed) fail('dedicated staging account/tenant is not clean');
  return Object.freeze({ stage: 'clean', passed: true });
}

export function decodeM1BRecoveryStateEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'activeMissionCount',
    'missionEventCount',
    'draftCount',
    'tenantLeaseCount',
    'candidateCount',
    'candidateMatches',
    'missionId',
    'missionRevision',
    'startCommandId',
    'draftSessionId',
    'draftSlotRevision',
    'draftContentRevision',
  ];
  if (!exactObject(value, keys)) fail('recovery-state proof shape is invalid');
  if (value.roleMatches !== true || value.roleSafe !== true || value.tenantLeaseCount !== 0) {
    fail('recovery-state runtime/RLS proof did not pass exactly');
  }
  if (
    value.activeMissionCount === 0 &&
    value.missionEventCount === 0 &&
    value.draftCount === 0 &&
    value.candidateCount === 0 &&
    value.candidateMatches === false &&
    value.missionId === null &&
    value.missionRevision === null &&
    value.startCommandId === null &&
    value.draftSessionId === null &&
    value.draftSlotRevision === null &&
    value.draftContentRevision === null
  ) {
    return Object.freeze({ stage: 'recovery-state', passed: true, state: 'clean' });
  }
  if (
    value.activeMissionCount !== 1 ||
    value.missionEventCount !== 1 ||
    value.draftCount !== 1 ||
    value.candidateCount !== 1 ||
    value.candidateMatches !== true ||
    typeof value.missionId !== 'string' ||
    !UUID.test(value.missionId) ||
    value.missionRevision !== 1 ||
    typeof value.startCommandId !== 'string' ||
    !UUID.test(value.startCommandId) ||
    typeof value.draftSessionId !== 'string' ||
    !IDENTIFIER.test(value.draftSessionId) ||
    value.draftSlotRevision !== 1 ||
    value.draftContentRevision !== 0
  ) {
    fail('recovery-state candidate is not the exact technical residue');
  }
  return Object.freeze({
    stage: 'recovery-state',
    passed: true,
    state: 'recoverable',
    candidate: Object.freeze({
      missionId: value.missionId,
      missionRevision: value.missionRevision,
      startCommandId: value.startCommandId,
      draftSessionId: value.draftSessionId,
      draftSlotRevision: value.draftSlotRevision,
      draftContentRevision: value.draftContentRevision,
    }),
  });
}

export function decodeM1BRecoveryTerminalEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'terminalCount',
    'terminalMatches',
    'missionEventCount',
    'activeMissionCount',
    'missionId',
    'terminalStatus',
    'missionRevision',
    'terminalAt',
  ];
  if (
    !exactObject(value, keys) ||
    value.roleMatches !== true ||
    value.roleSafe !== true ||
    value.terminalCount !== 1 ||
    value.terminalMatches !== true ||
    value.missionEventCount !== 2 ||
    value.activeMissionCount !== 0 ||
    typeof value.missionId !== 'string' ||
    !UUID.test(value.missionId) ||
    (value.terminalStatus !== 'cancelled' && value.terminalStatus !== 'expired') ||
    value.missionRevision !== 2 ||
    typeof value.terminalAt !== 'string' ||
    !Number.isFinite(Date.parse(value.terminalAt))
  ) {
    fail('recovery terminal proof did not pass exactly');
  }
  return Object.freeze({
    stage: 'recovery-terminal',
    passed: true,
    status: value.terminalStatus,
    missionRevision: value.missionRevision,
  });
}

export function decodeM1BStartRecoveryEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'recoveryCount',
    'recoveryMatches',
    'activeMissionCount',
    'draftCount',
    'missionId',
    'missionRevision',
    'draftSessionId',
    'draftSlotRevision',
    'draftContentRevision',
  ];
  if (!exactObject(value, keys)) fail('start recovery proof shape is invalid');
  if (
    value.roleMatches !== true ||
    value.roleSafe !== true ||
    value.recoveryCount !== 1 ||
    value.recoveryMatches !== true ||
    value.activeMissionCount !== 1 ||
    value.draftCount !== 1 ||
    typeof value.missionId !== 'string' ||
    !UUID.test(value.missionId) ||
    value.missionRevision !== 1 ||
    typeof value.draftSessionId !== 'string' ||
    !IDENTIFIER.test(value.draftSessionId) ||
    value.draftSlotRevision !== 1 ||
    value.draftContentRevision !== 0
  ) {
    fail('start response-loss recovery proof did not pass exactly');
  }
  return Object.freeze({
    stage: 'start-recovered',
    passed: true,
    mission: Object.freeze({
      id: value.missionId,
      status: 'active',
      actionable: true,
      phase: 'awaiting_quote_screen',
      revision: value.missionRevision,
      currentBinding: null,
      payload: Object.freeze({
        draft: Object.freeze({
          sessionId: value.draftSessionId,
          slotRevision: value.draftSlotRevision,
          contentRevision: value.draftContentRevision,
        }),
      }),
    }),
  });
}

export function decodeM1BCancellationRecoveryEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'recoveryCount',
    'recoveryMatches',
    'missionId',
    'missionRevision',
    'terminalAt',
  ];
  if (!exactObject(value, keys)) fail('cancellation recovery proof shape is invalid');
  if (
    value.roleMatches !== true ||
    value.roleSafe !== true ||
    value.recoveryCount !== 1 ||
    value.recoveryMatches !== true ||
    typeof value.missionId !== 'string' ||
    !UUID.test(value.missionId) ||
    !Number.isSafeInteger(value.missionRevision) ||
    value.missionRevision < 2 ||
    typeof value.terminalAt !== 'string' ||
    !Number.isFinite(Date.parse(value.terminalAt))
  ) {
    fail('cancellation response-loss recovery proof did not pass exactly');
  }
  return Object.freeze({
    stage: 'cancellation-recovered',
    passed: true,
    mission: Object.freeze({
      id: value.missionId,
      status: 'cancelled',
      actionable: false,
      revision: value.missionRevision,
      terminalAt: value.terminalAt,
    }),
  });
}

export function decodeM1BFinalEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'missionCount',
    'missionCancelled',
    'eventCount',
    'eventsMatch',
    'draftCount',
    'leaseCount',
    'activeMissionCount',
  ];
  if (!exactObject(value, keys)) fail('final proof shape is invalid');
  const passed =
    value.roleMatches === true &&
    value.roleSafe === true &&
    value.missionCount === 1 &&
    value.missionCancelled === true &&
    value.eventCount === 3 &&
    value.eventsMatch === true &&
    value.draftCount === 0 &&
    value.leaseCount === 0 &&
    value.activeMissionCount === 0;
  if (!passed) fail('final runtime cleanup proof did not pass exactly');
  return Object.freeze({ stage: 'final', passed: true });
}

export function decodeM1BNegativeFinalEvidence(value) {
  const keys = [
    'roleMatches',
    'roleSafe',
    'sessionLeaseCount',
    'tenantLeaseCount',
    'activeMissionCount',
    'draftCount',
  ];
  if (!exactObject(value, keys)) fail('negative final proof shape is invalid');
  const passed =
    value.roleMatches === true &&
    value.roleSafe === true &&
    value.sessionLeaseCount === 0 &&
    value.tenantLeaseCount === 0 &&
    value.activeMissionCount === 0 &&
    value.draftCount === 0;
  if (!passed) fail('negative runtime cleanup proof did not pass exactly');
  return Object.freeze({ stage: 'negative-final', passed: true });
}

export function certifyM1BActiveEvidence(input, environment = process.env, dependencies = {}) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  const variables = {
    ...baseVariables(config, input),
    mission_revision: positiveRevision(input.missionRevision, 'missionRevision'),
    context_revision: positiveRevision(input.contextRevision, 'contextRevision'),
    context_digest: digest(input.contextDigest, 'contextDigest'),
    screen_instance_id: identifier(input.screenInstanceId, 'screenInstanceId'),
    draft_session_id: identifier(input.draftSessionId, 'draftSessionId'),
    draft_slot_revision: positiveRevision(input.draftSlotRevision, 'draftSlotRevision'),
    draft_content_revision: positiveRevision(
      input.draftContentRevision,
      'draftContentRevision',
      true,
    ),
    sentinel_company_id: `m1b-sentinel-${input.missionId}`,
    sentinel_user_id: '00000000-0000-4000-8000-000000000000',
  };
  return decodeM1BActiveEvidence(psql(config, ACTIVE_SQL, variables, environment, dependencies));
}

export function certifyM1BCleanEvidence(environment = process.env, dependencies = {}) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  return decodeM1BCleanEvidence(
    psql(
      config,
      CLEAN_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
      },
      environment,
      dependencies,
    ),
  );
}

export function certifyM1BRecoveryStateEvidence(environment = process.env, dependencies = {}) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  return decodeM1BRecoveryStateEvidence(
    psql(
      config,
      RECOVERY_STATE_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
      },
      environment,
      dependencies,
    ),
  );
}

export function certifyM1BRecoveryTerminalEvidence(
  input,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  return decodeM1BRecoveryTerminalEvidence(
    psql(
      config,
      RECOVERY_TERMINAL_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
        mission_id: uuid(input.missionId, 'missionId'),
        start_command_id: uuid(input.startCommandId, 'startCommandId'),
        cancel_command_id: uuid(input.cancelCommandId, 'cancelCommandId'),
        draft_session_id: identifier(input.draftSessionId, 'draftSessionId'),
        draft_slot_revision: positiveRevision(input.draftSlotRevision, 'draftSlotRevision'),
        draft_content_revision: positiveRevision(
          input.draftContentRevision,
          'draftContentRevision',
          true,
        ),
      },
      environment,
      dependencies,
    ),
  );
}

export function certifyM1BStartRecoveryEvidence(
  input,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  return decodeM1BStartRecoveryEvidence(
    psql(
      config,
      START_RECOVERY_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
        start_command_id: uuid(input.startCommandId, 'startCommandId'),
      },
      environment,
      dependencies,
    ),
  );
}

export function certifyM1BCancellationRecoveryEvidence(
  input,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  const missionRevision = Number(input.expectedMissionRevision) + 1;
  return decodeM1BCancellationRecoveryEvidence(
    psql(
      config,
      CANCELLATION_RECOVERY_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
        mission_id: uuid(input.missionId, 'missionId'),
        start_command_id: uuid(input.startCommandId, 'startCommandId'),
        cancel_command_id: uuid(input.cancelCommandId, 'cancelCommandId'),
        expected_mission_revision: positiveRevision(
          input.expectedMissionRevision,
          'expectedMissionRevision',
        ),
        mission_revision: positiveRevision(missionRevision, 'missionRevision'),
        draft_session_id: identifier(input.draftSessionId, 'draftSessionId'),
        draft_content_revision: positiveRevision(
          input.draftContentRevision,
          'draftContentRevision',
          true,
        ),
      },
      environment,
      dependencies,
    ),
  );
}

export function certifyM1BFinalEvidence(input, environment = process.env, dependencies = {}) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  const variables = {
    ...baseVariables(config, input),
    cancel_command_id: uuid(input.cancelCommandId, 'cancelCommandId'),
    mission_revision: positiveRevision(input.missionRevision, 'missionRevision'),
  };
  return decodeM1BFinalEvidence(psql(config, FINAL_SQL, variables, environment, dependencies));
}

export function certifyM1BNegativeFinalEvidence(
  input,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingEvidenceEnvironment(environment);
  return decodeM1BNegativeFinalEvidence(
    psql(
      config,
      NEGATIVE_FINAL_SQL,
      {
        app_role: config.appRole,
        company_id: config.companyId,
        user_id: config.userId,
        session_id: uuid(input.sessionId, 'sessionId'),
      },
      environment,
      dependencies,
    ),
  );
}

export const M1B_CLEAN_EVIDENCE_SQL = CLEAN_SQL;
export const M1B_RECOVERY_STATE_EVIDENCE_SQL = RECOVERY_STATE_SQL;
export const M1B_RECOVERY_TERMINAL_EVIDENCE_SQL = RECOVERY_TERMINAL_SQL;
export const M1B_START_RECOVERY_EVIDENCE_SQL = START_RECOVERY_SQL;
export const M1B_CANCELLATION_RECOVERY_EVIDENCE_SQL = CANCELLATION_RECOVERY_SQL;
export const M1B_ACTIVE_EVIDENCE_SQL = ACTIVE_SQL;
export const M1B_FINAL_EVIDENCE_SQL = FINAL_SQL;
export const M1B_NEGATIVE_FINAL_EVIDENCE_SQL = NEGATIVE_FINAL_SQL;
