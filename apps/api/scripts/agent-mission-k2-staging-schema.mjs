#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertAppliedMigrationChecksums,
  readLocalMigrationChecksums,
} from './assert-applied-migration-checksums.mjs';
import { certifyM1BStagingDatabase } from './agent-mission-m1b-staging-database.mjs';
import {
  boundedPsqlSpawnOptions,
  withPsqlChildEnvironment,
} from './psql-child-environment.mjs';

export const K2_MIGRATION_NAME =
  '20260729110000_agent_mission_global_foreground_expand';

const SHA = /^[a-f0-9]{40}$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/u;
const DATABASE_ROLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/u;
const MIGRATION_PROCESS_TIMEOUT_MS = 120_000;
const EVIDENCE_DIRECTORY = '.release-evidence/agent-mission-k2';

const MIGRATION_INVENTORY_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.format(
         '%s|%s|%s|%s|%s',
         migration_name,
         checksum,
         CASE WHEN finished_at IS NULL THEN 'false' ELSE 'true' END,
         CASE WHEN rolled_back_at IS NULL THEN 'false' ELSE 'true' END,
         applied_steps_count
       )
  FROM public."_prisma_migrations"
 ORDER BY started_at, id;
`;

const SCHEMA_STATE_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
WITH mission_table AS (
  SELECT relation.oid,
         relation.relowner,
         pg_catalog.pg_get_userbyid(relation.relowner) AS owner_name,
         relation.relrowsecurity,
         relation.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p')
),
foreground_indexes AS (
  SELECT index_relation.relname AS name,
         pg_catalog.pg_get_userbyid(index_relation.relowner) AS owner_name,
         access_method.amname AS access_method,
         catalog_index.indisunique,
         catalog_index.indisvalid,
         catalog_index.indisready,
         catalog_index.indislive,
         catalog_index.indnkeyatts,
         catalog_index.indnatts,
         (
           SELECT pg_catalog.jsonb_agg(
                    pg_catalog.pg_get_indexdef(
                      catalog_index.indexrelid,
                      ordinal.position,
                      FALSE
                    )
                    ORDER BY ordinal.position
                  )
             FROM pg_catalog.generate_series(
                    1,
                    catalog_index.indnkeyatts
                  ) AS ordinal(position)
         ) AS key_columns,
         pg_catalog.regexp_replace(
           pg_catalog.pg_get_expr(
             catalog_index.indpred,
             catalog_index.indrelid
           ),
           '[[:space:]()"]',
           '',
           'g'
         ) AS normalized_predicate
    FROM mission_table
    JOIN pg_catalog.pg_index AS catalog_index
      ON catalog_index.indrelid = mission_table.oid
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = catalog_index.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE index_relation.relname IN (
     'agent_missions_one_active_owner_kind_key',
     'agent_missions_one_active_owner_key'
   )
)
SELECT pg_catalog.jsonb_build_object(
         'sessionUser', SESSION_USER,
         'currentUser', CURRENT_USER,
         'tableOwner', mission_table.owner_name,
         'ownerRole', (
           SELECT pg_catalog.jsonb_build_object(
                    'login', role.rolcanlogin,
                    'superuser', role.rolsuper,
                    'bypassRls', role.rolbypassrls,
                    'createDatabase', role.rolcreatedb,
                    'createRole', role.rolcreaterole,
                    'inherit', role.rolinherit
                  )
             FROM pg_catalog.pg_roles AS role
            WHERE role.oid = mission_table.relowner
         ),
         'directOwnerMembership', (
           SELECT pg_catalog.jsonb_build_object(
                    'set', membership.set_option,
                    'inherit', membership.inherit_option,
                    'admin', membership.admin_option
                  )
             FROM pg_catalog.pg_auth_members AS membership
            WHERE membership.roleid = mission_table.relowner
              AND membership.member = (
                SELECT role.oid
                  FROM pg_catalog.pg_roles AS role
                 WHERE role.rolname = SESSION_USER
              )
         ),
         'deployerCanSetOwner',
           CURRENT_USER = mission_table.owner_name
           OR pg_catalog.pg_has_role(
             SESSION_USER,
             mission_table.relowner,
             'SET'
           ),
         'rowSecurity', mission_table.relrowsecurity,
         'forceRowSecurity', mission_table.relforcerowsecurity,
         'kindConstraintValidated', EXISTS (
           SELECT 1
             FROM pg_catalog.pg_constraint AS constraint_catalog
            WHERE constraint_catalog.conrelid = mission_table.oid
              AND constraint_catalog.conname = 'agent_missions_kind_check'
              AND constraint_catalog.contype = 'c'
              AND constraint_catalog.convalidated
         ),
         'indexes', coalesce(
           (
             SELECT pg_catalog.jsonb_object_agg(
                      foreground_indexes.name,
                      pg_catalog.jsonb_build_object(
                        'owner', foreground_indexes.owner_name,
                        'accessMethod', foreground_indexes.access_method,
                        'unique', foreground_indexes.indisunique,
                        'valid', foreground_indexes.indisvalid,
                        'ready', foreground_indexes.indisready,
                        'live', foreground_indexes.indislive,
                        'keyAttributeCount', foreground_indexes.indnkeyatts,
                        'attributeCount', foreground_indexes.indnatts,
                        'keyColumns', foreground_indexes.key_columns,
                        'predicate', foreground_indexes.normalized_predicate
                      )
                    )
               FROM foreground_indexes
           ),
           '{}'::JSONB
         )
       )::TEXT
  FROM mission_table;
`;

const FOREIGN_AUTHORITY_SNAPSHOT_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.jsonb_build_object(
  'conversationFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(floor) ORDER BY floor."keySpace"),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_key_version_floors AS floor
  ),
  'conversationBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(binding)
        ORDER BY binding."keySpace", binding."keyVersion"
      ),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_key_bindings AS binding
  ),
  'identityFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(floor) ORDER BY floor."keySpace"),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_identity_key_version_floors AS floor
  ),
  'identityBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(binding)
        ORDER BY binding."keySpace", binding."keyVersion"
      ),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_identity_key_bindings AS binding
  ),
  'missionFingerprintFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(floor) ORDER BY floor."keySpace"),
      '[]'::JSONB
    )
      FROM public.agent_mission_fingerprint_key_version_floors AS floor
  ),
  'missionFingerprintBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(binding)
        ORDER BY binding."keyVersion"
      ),
      '[]'::JSONB
    )
      FROM public.agent_mission_fingerprint_key_bindings AS binding
  ),
  'releaseFlags', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'key', flag.key,
          'environment', flag.environment,
          'enabled', flag.enabled,
          'killSwitch', flag."killSwitch",
          'version', flag.version
        )
        ORDER BY flag.key, flag.environment
      ),
      '[]'::JSONB
    )
      FROM public.release_flags AS flag
  ),
  'releaseFlagSubjects', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'flagId', subject."flagId",
          'subjectType', subject."subjectType",
          'subjectId', subject."subjectId",
          'enabled', subject.enabled,
          'version', subject.version
        )
        ORDER BY subject."flagId", subject."subjectType", subject."subjectId"
      ),
      '[]'::JSONB
    )
      FROM public.release_flag_subjects AS subject
  ),
  'archiveProtocol', (
    SELECT pg_catalog.to_jsonb(protocol)
      FROM public.document_archive_protocol_state AS protocol
     WHERE protocol.id = 1
  ),
  'settlementProtocol', (
    SELECT pg_catalog.to_jsonb(protocol)
      FROM public.invoice_settlement_protocol_state AS protocol
     WHERE protocol.id = 1
  )
)::TEXT;
`;

const REALTIME_CAPACITY_SNAPSHOT_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SET LOCAL ROLE bob_realtime_capacity;
SELECT pg_catalog.jsonb_build_object(
         'id', capacity.id,
         'mode', capacity.mode,
         'providerId', capacity."providerId",
         'providerModel', capacity."providerModel",
         'globalMaxSessions', capacity."globalMaxSessions",
         'providerMaxSessions', capacity."providerMaxSessions",
         'configVersion', capacity."configVersion",
         'retryAfterSeconds', capacity."retryAfterSeconds",
         'activatedAt', capacity."activatedAt"
       )::TEXT
  FROM public.realtime_global_capacity AS capacity
 WHERE capacity.id = 1;
`;

const N1_WRITER_SQL = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('app.current_company_id', :'company_id', TRUE);
SELECT pg_catalog.set_config('app.current_user_id', :'owner_user_id', TRUE);
SELECT pg_catalog.set_config('app.current_agent_mission_id', :'mission_id', TRUE);
SELECT pg_catalog.set_config('bob.cert.k2_event_id', :'event_id', TRUE);
SELECT pg_catalog.set_config('bob.cert.k2_command_id', :'command_id', TRUE);
SELECT pg_catalog.set_config(
  'bob.cert.k2_fingerprint_key_version',
  :'fingerprint_key_version',
  TRUE
);
SELECT pg_catalog.set_config(
  'bob.cert.k2_fingerprint_writer_enabled',
  :'writer_enabled',
  TRUE
);
SELECT pg_catalog.set_config(
  'bob.cert.k2_started_at',
  pg_catalog.clock_timestamp()::TEXT,
  TRUE
);

INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  :'mission_id'::UUID,
  :'company_id',
  :'owner_user_id',
  'quote_creation',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  pg_catalog.jsonb_build_object(
    'schema', 'bob.agent-mission.quote-creation',
    'version', 1,
    'draft', pg_catalog.jsonb_build_object(
      'sessionId', :'owner_user_id',
      'slotRevision', 1,
      'contentRevision', 0
    ),
    'decision', 'null'::JSONB
  ),
  NULL,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '24 hours',
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '168 hours',
  NULL,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '2328 hours',
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
);

INSERT INTO public.quote_draft_slots (
  "companyId", "ownerUserId", "revision", "payloadVersion", "payload",
  "agentMissionId"
) VALUES (
  :'company_id',
  :'owner_user_id',
  1,
  1,
  pg_catalog.jsonb_build_object(
    'schema', 'bob.quote-draft',
    'version', 1,
    'draft', pg_catalog.jsonb_build_object(
      'sessionId', :'owner_user_id',
      'contentRevision', 0,
      'stagingRevision', 0,
      'step', 'client',
      'customer', 'null'::JSONB,
      'lines', '[]'::JSONB,
      'lineMetadata', '[]'::JSONB,
      'lineForm', pg_catalog.jsonb_build_object(
        'label', '',
        'quantity', '1',
        'unitPrice', '',
        'category', 'labor'
      ),
      'vatDecision', 'null'::JSONB,
      'depositPct', 30,
      'signMode', 'null'::JSONB
    )
  ),
  :'mission_id'::UUID
);

DO $agent_mission_k2_n1_writer$
DECLARE
  expected_writer_enabled BOOLEAN :=
    pg_catalog.current_setting(
      'bob.cert.k2_fingerprint_writer_enabled'
    )::BOOLEAN;
  rejected BOOLEAN := FALSE;
  rejected_by TEXT;
BEGIN
  BEGIN
    INSERT INTO public.agent_mission_events (
      "id", "companyId", "ownerUserId", "missionId", "sequence", "eventType",
      "eventVersion", "actor", "commandId", "requestFingerprintHmac",
      "fingerprintKeyVersion", "fingerprintCanonicalizationVersion",
      "missionRevisionBefore", "missionRevisionAfter", "draftSlotRevisionBefore",
      "draftSlotRevisionAfter", "draftContentRevisionBefore",
      "draftContentRevisionAfter", "realtimeSessionId", "turnId",
      "contextRevision", "contextDigest", "data", "occurredAt",
      "retentionExpiresAt"
    ) VALUES (
      pg_catalog.current_setting('bob.cert.k2_event_id')::UUID,
      pg_catalog.current_setting('app.current_company_id'),
      pg_catalog.current_setting('app.current_user_id'),
      pg_catalog.current_setting('app.current_agent_mission_id')::UUID,
      1,
      'mission_started',
      1,
      'user_tap',
      pg_catalog.current_setting('bob.cert.k2_command_id')::UUID,
      pg_catalog.repeat('1', 64),
      pg_catalog.current_setting(
        'bob.cert.k2_fingerprint_key_version'
      )::INTEGER,
      1,
      0,
      1,
      NULL,
      1,
      NULL,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      '{"kind":"mission_started","startOutcome":"no_slot"}'::JSONB,
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
        + INTERVAL '2160 hours'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS rejected_by = CONSTRAINT_NAME;
    IF expected_writer_enabled
       OR rejected_by <> 'agent_mission_fingerprint_key_writer_disabled' THEN
      RAISE;
    END IF;
    rejected := TRUE;
  END;
  IF expected_writer_enabled AND rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_K2_N1_WRITER_UNEXPECTEDLY_REJECTED';
  END IF;
  IF NOT expected_writer_enabled AND NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_K2_DISABLED_FINGERPRINT_WRITER_ACCEPTED';
  END IF;
END;
$agent_mission_k2_n1_writer$;

\if :writer_enabled
SET CONSTRAINTS ALL IMMEDIATE;
\endif

ROLLBACK;
`;

const CROSS_KIND_SQL = `
BEGIN;
SELECT pg_catalog.format('SET LOCAL ROLE %I', :'schema_owner') \\gexec
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_kind_check;

SELECT pg_catalog.set_config('app.current_company_id', :'company_id', TRUE);
SELECT pg_catalog.set_config('app.current_user_id', :'owner_user_id', TRUE);
SELECT pg_catalog.set_config('app.current_agent_mission_id', :'first_mission_id', TRUE);
SELECT pg_catalog.set_config(
  'bob.cert.k2_second_mission_id',
  :'second_mission_id',
  TRUE
);
SELECT pg_catalog.set_config(
  'bob.cert.k2_started_at',
  pg_catalog.clock_timestamp()::TEXT,
  TRUE
);

INSERT INTO public.agent_missions (
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
  "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
) VALUES (
  :'first_mission_id'::UUID,
  :'company_id',
  :'owner_user_id',
  'quote_creation',
  'active',
  'awaiting_quote_screen',
  1,
  1,
  pg_catalog.jsonb_build_object(
    'schema', 'bob.agent-mission.quote-creation',
    'version', 1,
    'draft', pg_catalog.jsonb_build_object(
      'sessionId', :'owner_user_id',
      'slotRevision', 1,
      'contentRevision', 0
    ),
    'decision', 'null'::JSONB
  ),
  NULL,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '24 hours',
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '168 hours',
  NULL,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    + INTERVAL '2328 hours',
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
  pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
);

DO $agent_mission_k2_cross_kind$
DECLARE
  rejected BOOLEAN := FALSE;
  rejected_by TEXT;
BEGIN
  PERFORM pg_catalog.set_config(
    'app.current_agent_mission_id',
    pg_catalog.current_setting('bob.cert.k2_second_mission_id'),
    TRUE
  );
  BEGIN
    INSERT INTO public.agent_missions (
      "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
      "payloadVersion", "payload", "currentBinding", "idleExpiresAt", "hardExpiresAt",
      "terminalAt", "retentionExpiresAt", "createdAt", "updatedAt"
    ) VALUES (
      pg_catalog.current_setting('bob.cert.k2_second_mission_id')::UUID,
      pg_catalog.current_setting('app.current_company_id'),
      pg_catalog.current_setting('app.current_user_id'),
      'maintenance_contract',
      'active',
      'awaiting_quote_screen',
      1,
      1,
      pg_catalog.jsonb_build_object(
        'schema', 'bob.agent-mission.quote-creation',
        'version', 1,
        'draft', pg_catalog.jsonb_build_object(
          'sessionId', pg_catalog.current_setting('app.current_user_id'),
          'slotRevision', 1,
          'contentRevision', 0
        ),
        'decision', 'null'::JSONB
      ),
      NULL,
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
        + INTERVAL '24 hours',
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
        + INTERVAL '168 hours',
      NULL,
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
        + INTERVAL '2328 hours',
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ,
      pg_catalog.current_setting('bob.cert.k2_started_at')::TIMESTAMPTZ
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS rejected_by = CONSTRAINT_NAME;
    IF rejected_by <> 'agent_missions_one_active_owner_key' THEN
      RAISE EXCEPTION 'AGENT_MISSION_K2_WRONG_UNIQUE_BACKSTOP:%', rejected_by;
    END IF;
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'AGENT_MISSION_K2_CROSS_KIND_ACTIVE_ACCEPTED';
  END IF;
END;
$agent_mission_k2_cross_kind$;

ROLLBACK;
`;

const RESIDUE_SQL = `
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.format('SET LOCAL ROLE %I', :'schema_owner') \\gexec
SELECT pg_catalog.format(
         '%s|%s|%s',
         (
           SELECT pg_catalog.count(*)
             FROM public.agent_missions
            WHERE "companyId" = :'company_id'
              AND "ownerUserId" IN (
                :'n1_owner_user_id',
                :'cross_owner_user_id'
              )
         ),
         (
           SELECT pg_catalog.count(*)
             FROM public.agent_mission_events
            WHERE "companyId" = :'company_id'
              AND "ownerUserId" IN (
                :'n1_owner_user_id',
                :'cross_owner_user_id'
              )
         ),
         (
           SELECT pg_catalog.count(*)
             FROM public.quote_draft_slots
            WHERE "companyId" = :'company_id'
              AND "ownerUserId" IN (
                :'n1_owner_user_id',
                :'cross_owner_user_id'
              )
         )
       );
`;

const FINGERPRINT_WRITER_VERSION_SQL = `
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SELECT floor."minimumWriterVersion"
       || '|'
       || CASE WHEN floor."writerEnabled" THEN 'true' ELSE 'false' END
  FROM public.agent_mission_fingerprint_key_version_floors AS floor
 WHERE floor."keySpace" = 'bob-agent-mission-fingerprint-hmac-v1'
   AND EXISTS (
     SELECT 1
       FROM public.agent_mission_fingerprint_key_bindings AS binding
      WHERE binding."keyVersion" = floor."minimumWriterVersion"
   );
`;

function fail(message) {
  throw new Error(`agent-mission-k2-staging-schema:${message}`);
}

function required(environment, name, maximum = 8_192) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed) {
  const hex = sha256(seed);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export function parseK2StagingEnvironment(command, environment = process.env) {
  if (command !== 'apply') fail('command must be apply');
  if (required(environment, 'CABINET_RELEASE_ENV', 16) !== 'staging') {
    fail('this schema gate is staging-only');
  }
  const releaseSha = required(environment, 'BOB_K2_RELEASE_SHA', 40);
  if (!SHA.test(releaseSha)) fail('BOB_K2_RELEASE_SHA must be an exact commit SHA');
  const appRole = required(environment, 'APP_DATABASE_ROLE', 63);
  if (!DATABASE_ROLE.test(appRole)) fail('APP_DATABASE_ROLE must be canonical');
  const companyId = required(environment, 'BOB_M1B_STAGING_COMPANY_ID', 64);
  if (!COMPANY_ID.test(companyId)) {
    fail('BOB_M1B_STAGING_COMPANY_ID must be canonical');
  }
  const runId = required(environment, 'GITHUB_RUN_ID', 20);
  const runAttempt = required(environment, 'GITHUB_RUN_ATTEMPT', 10);
  if (!POSITIVE_INTEGER.test(runId) || !POSITIVE_INTEGER.test(runAttempt)) {
    fail('GitHub run identity must be canonical');
  }
  const directUrl = required(environment, 'DIRECT_URL');
  const runtimeUrl = required(environment, 'DATABASE_URL');
  const projectRef = required(
    environment,
    'BOB_M1B_STAGING_SUPABASE_PROJECT_REF',
    20,
  );
  const systemIdentifier = required(
    environment,
    'BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER',
    30,
  );
  const databaseOid = required(environment, 'BOB_M1B_STAGING_DATABASE_OID', 10);
  const databaseName = required(
    environment,
    'BOB_M1B_STAGING_DATABASE_NAME',
    63,
  );
  const identitySeed = `${releaseSha}:${runId}`;
  return Object.freeze({
    command,
    environment,
    releaseSha,
    appRole,
    companyId,
    runId,
    runAttempt,
    directUrl,
    runtimeUrl,
    databasePinHash: sha256(
      `${projectRef}:${systemIdentifier}:${databaseOid}:${databaseName}`,
    ),
    n1OwnerUserId: `system:k2-n1:${sha256(`${identitySeed}:n1`).slice(0, 24)}`,
    crossOwnerUserId:
      `system:k2-cross:${sha256(`${identitySeed}:cross`).slice(0, 24)}`,
    n1MissionId: deterministicUuid(`${identitySeed}:n1-mission`),
    n1EventId: deterministicUuid(`${identitySeed}:n1-event`),
    n1CommandId: deterministicUuid(`${identitySeed}:n1-command`),
    crossFirstMissionId: deterministicUuid(`${identitySeed}:cross-first`),
    crossSecondMissionId: deterministicUuid(`${identitySeed}:cross-second`),
  });
}

export function parseK2MigrationInventory(raw) {
  if (typeof raw !== 'string') fail('migration inventory must be text');
  if (raw.trim() === '') return [];
  return raw.trim().split('\n').map((line) => {
    const [name, checksum, finished, rolledBack, appliedSteps, ...unexpected] =
      line.split('|');
    if (
      unexpected.length > 0
      || !MIGRATION_NAME.test(name ?? '')
      || !CHECKSUM.test(checksum ?? '')
      || !['true', 'false'].includes(finished)
      || !['true', 'false'].includes(rolledBack)
      || !/^(0|[1-9][0-9]{0,9})$/u.test(appliedSteps ?? '')
    ) {
      fail('migration inventory is malformed');
    }
    const row = Object.freeze({
      name,
      checksum,
      finished: finished === 'true',
      rolledBack: rolledBack === 'true',
      appliedSteps: Number(appliedSteps),
    });
    if (row.finished && row.rolledBack) {
      fail('migration inventory contains an impossible terminal state');
    }
    return row;
  });
}

function activeMigrations(inventory) {
  return inventory
    .filter(({ finished, rolledBack }) => finished && !rolledBack)
    .map(({ name, checksum }) => ({ name, checksum }));
}

function assertNoUnresolvedMigration(inventory) {
  if (inventory.some(({ finished, rolledBack }) => !finished && !rolledBack)) {
    fail('migration inventory contains an unresolved migration');
  }
}

export function assertK2PreflightMigrationState(inventory, local) {
  assertNoUnresolvedMigration(inventory);
  const targetChecksum = local.get(K2_MIGRATION_NAME);
  if (!CHECKSUM.test(targetChecksum ?? '')) {
    fail('the exact local K2 migration is missing');
  }
  const targetRows = inventory.filter(({ name }) => name === K2_MIGRATION_NAME);
  if (targetRows.length > 1) {
    fail('K2 migration history is ambiguous');
  }
  if (targetRows.length === 1) {
    const target = targetRows[0];
    if (
      !target.finished
      || target.rolledBack
      || target.appliedSteps !== 1
      || target.checksum !== targetChecksum
    ) {
      fail('K2 migration recovery state is not exact');
    }
    const applied = activeMigrations(inventory);
    let summary;
    try {
      summary = assertAppliedMigrationChecksums({
        applied,
        local,
        allowPendingLocal: false,
      });
    } catch {
      fail('K2 migration recovery checksum proof failed');
    }
    return Object.freeze({
      operation: 'recertify',
      appliedCount: summary.appliedCount,
      pendingCount: summary.pendingCount,
      targetChecksum,
    });
  }
  const applied = activeMigrations(inventory);
  try {
    assertAppliedMigrationChecksums({
      applied,
      local,
      allowPendingLocal: true,
    });
  } catch {
    fail('preflight migration checksum proof failed');
  }
  const appliedNames = new Set(applied.map(({ name }) => name));
  const pending = [...local.keys()].filter((name) => !appliedNames.has(name));
  if (pending.length !== 1 || pending[0] !== K2_MIGRATION_NAME) {
    fail('the pending migration set is not exactly K2');
  }
  return Object.freeze({
    operation: 'apply',
    appliedCount: applied.length,
    pendingCount: 1,
    targetChecksum,
  });
}

export function assertK2PostflightMigrationState(inventory, local) {
  assertNoUnresolvedMigration(inventory);
  const targetRows = inventory.filter(({ name }) => name === K2_MIGRATION_NAME);
  const targetChecksum = local.get(K2_MIGRATION_NAME);
  if (
    targetRows.length !== 1
    || !targetRows[0].finished
    || targetRows[0].rolledBack
    || targetRows[0].appliedSteps !== 1
    || targetRows[0].checksum !== targetChecksum
  ) {
    fail('K2 migration terminal record is not exact');
  }
  const applied = activeMigrations(inventory);
  let summary;
  try {
    summary = assertAppliedMigrationChecksums({
      applied,
      local,
      allowPendingLocal: false,
    });
  } catch {
    fail('postflight migration checksum proof failed');
  }
  return Object.freeze({
    appliedCount: summary.appliedCount,
    pendingCount: summary.pendingCount,
    targetChecksum,
  });
}

function decodeSchemaState(value) {
  let state;
  try {
    state = typeof value === 'string' ? JSON.parse(value.trim()) : value;
  } catch {
    fail('schema state is malformed');
  }
  if (
    state === null
    || typeof state !== 'object'
    || Array.isArray(state)
    || state.indexes === null
    || typeof state.indexes !== 'object'
    || Array.isArray(state.indexes)
  ) {
    fail('schema state is malformed');
  }
  return state;
}

function assertIndex(index, indexName, columns, expectedOwner) {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    fail(`foreground index definition drifted:${indexName}:missing`);
  }
  const drift = [];
  if (index.owner !== expectedOwner) drift.push('owner');
  if (index.accessMethod !== 'btree') drift.push('access-method');
  if (index.unique !== true) drift.push('unique');
  if (index.valid !== true) drift.push('valid');
  if (index.ready !== true) drift.push('ready');
  if (index.live !== true) drift.push('live');
  if (index.keyAttributeCount !== columns.length) drift.push('key-count');
  if (index.attributeCount !== columns.length) drift.push('attribute-count');
  if (JSON.stringify(index.keyColumns) !== JSON.stringify(columns)) {
    drift.push(
      `columns=${JSON.stringify(index.keyColumns).slice(0, 256)}`,
    );
  }
  if (index.predicate !== "status='active'::text") {
    drift.push(`predicate=${JSON.stringify(index.predicate).slice(0, 256)}`);
  }
  if (drift.length > 0) {
    fail(`foreground index definition drifted:${indexName}:${drift.join(',')}`);
  }
}

export function assertK2SchemaState(value, phase) {
  if (
    phase !== 'preflight'
    && phase !== 'recertification'
    && phase !== 'postflight'
  ) {
    fail('schema phase must be preflight, recertification or postflight');
  }
  const state = decodeSchemaState(value);
  if (
    state.tableOwner !== 'postgres'
    || state.sessionUser !== 'postgres'
    || state.currentUser !== state.sessionUser
    || state.ownerRole === null
    || typeof state.ownerRole !== 'object'
    || state.ownerRole.login !== true
    || state.ownerRole.superuser !== false
    || state.ownerRole.bypassRls !== true
    || state.directOwnerMembership !== null
    || state.deployerCanSetOwner !== true
    || state.rowSecurity !== true
    || state.forceRowSecurity !== true
    || state.kindConstraintValidated !== true
    || typeof state.sessionUser !== 'string'
    || typeof state.currentUser !== 'string'
  ) {
    fail('agent mission schema authority drifted');
  }
  assertIndex(
    state.indexes.agent_missions_one_active_owner_kind_key,
    'agent_missions_one_active_owner_kind_key',
    ['"companyId"', '"ownerUserId"', '"kind"'],
    state.tableOwner,
  );
  const globalIndex = state.indexes.agent_missions_one_active_owner_key;
  if (phase === 'preflight') {
    if (globalIndex !== undefined) {
      fail('the K2 global foreground index already exists before migration');
    }
  } else {
    assertIndex(
      globalIndex,
      'agent_missions_one_active_owner_key',
      ['"companyId"', '"ownerUserId"'],
      state.tableOwner,
    );
  }
  if (
    Object.keys(state.indexes).some(
      (name) =>
        name !== 'agent_missions_one_active_owner_kind_key'
        && name !== 'agent_missions_one_active_owner_key',
    )
  ) {
    fail('foreground index inventory contains an unexpected index');
  }
  return Object.freeze({
    schemaOwner: state.tableOwner,
    sessionUser: state.sessionUser,
  });
}

export function hashK2ForeignAuthoritySnapshot(snapshot) {
  if (
    typeof snapshot !== 'string'
    || snapshot.length < 2
    || snapshot.length > 512 * 1024
  ) {
    fail('foreign authority snapshot is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    fail('foreign authority snapshot is invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('foreign authority snapshot is invalid');
  }
  return sha256(snapshot);
}

export function buildK2Evidence({
  status,
  operation,
  config,
  migration,
  schemaOwner,
  foreignAuthorityHash,
  n1WriterOutcome,
  timestamp,
}) {
  if (
    !['preflight', 'certified'].includes(status)
    || !['apply', 'recertify'].includes(operation)
    || !CHECKSUM.test(migration.targetChecksum ?? '')
    || !DATABASE_ROLE.test(schemaOwner ?? '')
    || !CHECKSUM.test(foreignAuthorityHash ?? '')
    || !['not-run', 'accepted', 'disabled-fence'].includes(n1WriterOutcome)
    || (status === 'preflight' && n1WriterOutcome !== 'not-run')
    || (status === 'certified' && n1WriterOutcome === 'not-run')
    || typeof timestamp !== 'string'
  ) {
    fail('evidence input is invalid');
  }
  return Object.freeze({
    schema: 'bob.agent-mission.k2.staging-schema-evidence',
    version: 1,
    status,
    operation,
    releaseSha: config.releaseSha,
    migrationName: K2_MIGRATION_NAME,
    migrationChecksum: migration.targetChecksum,
    appliedMigrationCount: migration.appliedCount,
    pendingMigrationCount: migration.pendingCount,
    databasePinHash: config.databasePinHash,
    schemaOwner,
    foreignAuthorityHash,
    n1WriterOutcome,
    githubRunId: config.runId,
    githubRunAttempt: config.runAttempt,
    observedAt: timestamp,
  });
}

function writeEvidenceAtomically(evidence, config, dependencies = {}) {
  const directory = dependencies.evidenceDirectory ?? EVIDENCE_DIRECTORY;
  const mkdir = dependencies.mkdirSync ?? mkdirSync;
  const write = dependencies.writeFileSync ?? writeFileSync;
  const rename = dependencies.renameSync ?? renameSync;
  mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(
    directory,
    `staging-schema-${config.releaseSha}-${evidence.status}.json`,
  );
  const temporaryPath = `${finalPath}.tmp`;
  write(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  rename(temporaryPath, finalPath);
  return finalPath;
}

function securePsql(
  url,
  {
    input,
    variables = [],
    file,
    label = file ?? 'inline-sql',
    singleTransaction = file === undefined,
  },
  environment,
  dependencies = {},
) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const args = [
    '--no-psqlrc',
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
    ...(singleTransaction ? ['--single-transaction'] : []),
    ...variables.flatMap(([name, value]) => {
      if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name)) {
        fail('psql variable name is invalid');
      }
      return ['-v', `${name}=${value}`];
    }),
    ...(file === undefined ? [] : ['-f', file]),
  ];
  const result = withPsqlChildEnvironment(url, environment, (childEnvironment) =>
    spawn(
      'psql',
      args,
      boundedPsqlSpawnOptions(childEnvironment, {
        input,
        encoding: 'utf8',
      }),
    ),
  );
  if (result.status !== 0) {
    const kind =
      result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
        ? 'timeout'
        : 'nonzero-exit';
    fail(`PostgreSQL gate ${label} failed (${kind})`);
  }
  return String(result.stdout ?? '').trim();
}

function readMigrationInventory(config, dependencies = {}) {
  return parseK2MigrationInventory(
    securePsql(
      config.directUrl,
      { input: MIGRATION_INVENTORY_SQL, label: 'migration-inventory' },
      config.environment,
      dependencies,
    ),
  );
}

function readSchemaState(config, dependencies = {}) {
  return securePsql(
    config.directUrl,
    { input: SCHEMA_STATE_SQL, label: 'schema-state' },
    config.environment,
    dependencies,
  );
}

function foreignAuthorityHash(config, dependencies = {}) {
  const authorityHash = hashK2ForeignAuthoritySnapshot(
    securePsql(
      config.directUrl,
      {
        input: FOREIGN_AUTHORITY_SNAPSHOT_SQL,
        label: 'foreign-authority-snapshot',
      },
      config.environment,
      dependencies,
    ),
  );
  const realtimeCapacityHash = hashK2ForeignAuthoritySnapshot(
    securePsql(
      config.directUrl,
      {
        input: REALTIME_CAPACITY_SNAPSHOT_SQL,
        label: 'realtime-capacity-authority-snapshot',
      },
      config.environment,
      dependencies,
    ),
  );
  return sha256(`${authorityHash}:${realtimeCapacityHash}`);
}

function applyMigration(config, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(
    'pnpm',
    ['--filter', '@bob/api', 'exec', 'prisma', 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: config.environment,
      timeout: MIGRATION_PROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  if (result.status !== 0) {
    const kind =
      result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
        ? 'timeout'
        : 'nonzero-exit';
    fail(`Prisma migrate deploy failed (${kind})`);
  }
}

function certifyAcl(config, dependencies = {}) {
  securePsql(
    config.runtimeUrl,
    {
      file: 'apps/api/prisma/agent-missions-release-cert.sql',
      label: 'agent-mission-acl',
      variables: [['app_role', config.appRole]],
      singleTransaction: false,
    },
    config.environment,
    dependencies,
  );
}

function certificationVariables(config, schemaOwner) {
  return [
    ['schema_owner', schemaOwner],
    ['company_id', config.companyId],
    ['n1_owner_user_id', config.n1OwnerUserId],
    ['cross_owner_user_id', config.crossOwnerUserId],
  ];
}

function assertNoResidue(config, schemaOwner, dependencies = {}) {
  const count = securePsql(
    config.directUrl,
    {
      input: RESIDUE_SQL,
      label: 'certification-residue',
      variables: certificationVariables(config, schemaOwner),
    },
    config.environment,
    dependencies,
  );
  if (count !== '0|0|0') {
    fail('K2 rollback certification left mission, event or draft rows');
  }
}

function certifyN1Writer(config, dependencies = {}) {
  const fingerprintWriter = securePsql(
    config.directUrl,
    {
      input: FINGERPRINT_WRITER_VERSION_SQL,
      label: 'N-1-fingerprint-writer-version',
    },
    config.environment,
    dependencies,
  );
  const [
    fingerprintKeyVersion,
    writerEnabled,
    ...unexpectedFingerprintWriterFields
  ] = fingerprintWriter.split('|');
  if (
    !/^[1-9][0-9]{0,9}$/u.test(fingerprintKeyVersion)
    || Number(fingerprintKeyVersion) > 2_147_483_647
    || !['true', 'false'].includes(writerEnabled)
    || unexpectedFingerprintWriterFields.length > 0
  ) {
    fail('N-1 fingerprint writer version is unavailable');
  }
  securePsql(
    config.runtimeUrl,
    {
      input: N1_WRITER_SQL,
      label: 'N-1-runtime-writer',
      singleTransaction: false,
      variables: [
        ['company_id', config.companyId],
        ['owner_user_id', config.n1OwnerUserId],
        ['mission_id', config.n1MissionId],
        ['event_id', config.n1EventId],
        ['command_id', config.n1CommandId],
        ['fingerprint_key_version', fingerprintKeyVersion],
        ['writer_enabled', writerEnabled],
      ],
    },
    config.environment,
    dependencies,
  );
  return writerEnabled === 'true' ? 'accepted' : 'disabled-fence';
}

function certifyCrossKind(config, schemaOwner, dependencies = {}) {
  securePsql(
    config.directUrl,
    {
      input: CROSS_KIND_SQL,
      label: 'cross-kind-foreground',
      singleTransaction: false,
      variables: [
        ['schema_owner', schemaOwner],
        ['company_id', config.companyId],
        ['owner_user_id', config.crossOwnerUserId],
        ['first_mission_id', config.crossFirstMissionId],
        ['second_mission_id', config.crossSecondMissionId],
      ],
    },
    config.environment,
    dependencies,
  );
}

export async function runK2StagingSchema(
  command,
  environment = process.env,
  dependencies = {},
) {
  const config = parseK2StagingEnvironment(command, environment);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const certifyDatabase =
    dependencies.certifyDatabase ?? certifyM1BStagingDatabase;
  certifyDatabase(environment);

  const local = await (
    dependencies.readLocalMigrationChecksums ?? readLocalMigrationChecksums
  )();
  const preflightInventory = await (
    dependencies.readMigrationInventory ?? readMigrationInventory
  )(config, dependencies);
  const preflight = assertK2PreflightMigrationState(preflightInventory, local);
  const preflightSchema = await (
    dependencies.readSchemaState ?? readSchemaState
  )(config, dependencies);
  const preflightSchemaState = assertK2SchemaState(
    preflightSchema,
    preflight.operation === 'apply' ? 'preflight' : 'recertification',
  );
  await (dependencies.assertNoResidue ?? assertNoResidue)(
    config,
    preflightSchemaState.schemaOwner,
    dependencies,
  );
  const authorityHash = await (
    dependencies.foreignAuthorityHash ?? foreignAuthorityHash
  )(config, dependencies);
  const writeEvidence =
    dependencies.writeEvidence ?? writeEvidenceAtomically;
  await writeEvidence(
    buildK2Evidence({
      status: 'preflight',
      operation: preflight.operation,
      config,
      migration: preflight,
      schemaOwner: preflightSchemaState.schemaOwner,
      foreignAuthorityHash: authorityHash,
      n1WriterOutcome: 'not-run',
      timestamp: now(),
    }),
    config,
    dependencies,
  );

  if (preflight.operation === 'apply') {
    await (dependencies.applyMigration ?? applyMigration)(config, dependencies);
  }

  const postflightInventory = await (
    dependencies.readMigrationInventory ?? readMigrationInventory
  )(config, dependencies);
  const postflight = assertK2PostflightMigrationState(postflightInventory, local);
  const postflightSchema = await (
    dependencies.readSchemaState ?? readSchemaState
  )(config, dependencies);
  const postflightSchemaState = assertK2SchemaState(
    postflightSchema,
    'postflight',
  );
  if (postflightSchemaState.schemaOwner !== preflightSchemaState.schemaOwner) {
    fail('agent mission schema owner changed during the K2 gate');
  }
  const expectedAppliedCount =
    preflight.appliedCount + (preflight.operation === 'apply' ? 1 : 0);
  if (
    postflight.appliedCount !== expectedAppliedCount
    || postflight.pendingCount !== 0
  ) {
    fail('K2 migration count transition is not exact');
  }
  await (dependencies.certifyAcl ?? certifyAcl)(config, dependencies);
  const n1WriterOutcome = await (
    dependencies.certifyN1Writer ?? certifyN1Writer
  )(config, dependencies);
  if (!['accepted', 'disabled-fence'].includes(n1WriterOutcome)) {
    fail('N-1 writer certification returned an invalid outcome');
  }
  await (dependencies.certifyCrossKind ?? certifyCrossKind)(
    config,
    postflightSchemaState.schemaOwner,
    dependencies,
  );
  await (dependencies.assertNoResidue ?? assertNoResidue)(
    config,
    postflightSchemaState.schemaOwner,
    dependencies,
  );
  const finalAuthorityHash = await (
    dependencies.foreignAuthorityHash ?? foreignAuthorityHash
  )(config, dependencies);
  if (finalAuthorityHash !== authorityHash) {
    fail('a foreign protocol authority changed during the K2 schema gate');
  }

  const evidencePath = await writeEvidence(
    buildK2Evidence({
      status: 'certified',
      operation: preflight.operation,
      config,
      migration: postflight,
      schemaOwner: postflightSchemaState.schemaOwner,
      foreignAuthorityHash: finalAuthorityHash,
      n1WriterOutcome,
      timestamp: now(),
    }),
    config,
    dependencies,
  );
  return Object.freeze({
    status: 'certified',
    operation: preflight.operation,
    releaseSha: config.releaseSha,
    migrationName: K2_MIGRATION_NAME,
    appliedMigrationCount: postflight.appliedCount,
    pendingMigrationCount: postflight.pendingCount,
    evidencePath,
  });
}

async function main() {
  const result = await runK2StagingSchema(process.argv[2]);
  process.stdout.write(
    `agent-mission-k2-staging-schema:ok:${result.releaseSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'agent-mission-k2-staging-schema:failed'
      }\n`,
    );
    process.exitCode = 1;
  });
}
