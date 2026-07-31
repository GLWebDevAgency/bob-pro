#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

export const M2A3_STAGING_PHASES = Object.freeze([
  Object.freeze({
    phase: 'expand',
    migration:
      '20260731120000_agent_mission_line_cancel_choice_expand',
    state: 'S1',
  }),
  Object.freeze({
    phase: 'validate',
    migration:
      '20260731120100_agent_mission_line_cancel_choice_validate',
    state: 'S2',
  }),
  Object.freeze({
    phase: 'cutover',
    migration:
      '20260731120200_agent_mission_line_cancel_choice_cutover',
    state: 'S3',
  }),
]);

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/u;
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/u;
const MIGRATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DATABASE_ROLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
// La phase VALIDATE autorise cinq minutes côté PostgreSQL. Le parent garde une marge bornée
// pour le handshake Prisma et la fermeture propre de la connexion.
const MIGRATION_PROCESS_TIMEOUT_MS = 420_000;
const EVIDENCE_DIRECTORY = '.release-evidence/agent-mission-m2a3-schema';
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');
const PRISMA_DIRECTORY = join(REPOSITORY_ROOT, 'apps/api/prisma');
const M2A2_EXPAND_MIGRATION =
  '20260730110000_agent_mission_line_confirmation_expand';
const M2A2_DATA_CONSTRAINT = 'agent_mission_events_data_m2a2_check';
const M2A3_DATA_CONSTRAINT = 'agent_mission_events_data_m2a3_check';

const MIGRATION_INVENTORY_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.format(
         '%s|%s|%s|%s|%s|%s|%s',
         id,
         migration_name,
         checksum,
         CASE WHEN finished_at IS NULL THEN 'false' ELSE 'true' END,
         CASE WHEN rolled_back_at IS NULL THEN 'false' ELSE 'true' END,
         applied_steps_count,
         pg_catalog.floor(
           extract(epoch FROM started_at) * 1000000
         )::BIGINT
       )
  FROM public."_prisma_migrations"
 ORDER BY started_at, id;
`;

const SCHEMA_STATE_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
WITH relations AS (
  SELECT relation.relname,
         pg_catalog.pg_get_userbyid(relation.relowner) AS owner_name,
         relation.relrowsecurity,
         relation.relforcerowsecurity,
         pg_catalog.pg_has_role(SESSION_USER, relation.relowner, 'SET')
           AS deployer_can_set_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname IN ('agent_mission_events', 'release_flags')
     AND relation.relkind IN ('r', 'p')
),
constraints AS (
  SELECT constraint_catalog.conname,
         constraint_catalog.convalidated,
         constraint_catalog.contype,
         constraint_catalog.connoinherit,
         pg_catalog.pg_get_constraintdef(constraint_catalog.oid, TRUE)
           AS definition,
         pg_catalog.pg_get_expr(
           constraint_catalog.conbin,
           constraint_catalog.conrelid,
           TRUE
         ) AS expression
    FROM pg_catalog.pg_constraint AS constraint_catalog
   WHERE constraint_catalog.conrelid =
         'public.agent_mission_events'::pg_catalog.regclass
     AND constraint_catalog.conname IN (
       'agent_mission_events_data_check',
       'agent_mission_events_data_m2a3_check'
     )
),
data_api_privileges AS (
  SELECT pg_catalog.count(*)::INTEGER AS privilege_count
    FROM pg_catalog.unnest(
           ARRAY['anon', 'authenticated', 'service_role']
         ) AS exposed(role_name)
   CROSS JOIN pg_catalog.unnest(
           ARRAY['agent_mission_events', 'release_flags']
         ) AS protected(table_name)
   CROSS JOIN pg_catalog.unnest(
           ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
         ) AS permission(privilege_name)
   WHERE pg_catalog.to_regrole(exposed.role_name) IS NOT NULL
     AND pg_catalog.has_table_privilege(
       exposed.role_name,
       pg_catalog.format('public.%I', protected.table_name),
       permission.privilege_name
     )
)
SELECT pg_catalog.jsonb_build_object(
         'sessionUser', SESSION_USER,
         'currentUser', CURRENT_USER,
         'relations', (
           SELECT pg_catalog.jsonb_object_agg(
                    relation.relname,
                    pg_catalog.jsonb_build_object(
                      'owner', relation.owner_name,
                      'rowSecurity', relation.relrowsecurity,
                      'forceRowSecurity', relation.relforcerowsecurity,
                      'deployerCanSetOwner', relation.deployer_can_set_owner
                    )
                  )
             FROM relations AS relation
         ),
         'constraints', coalesce(
           (
             SELECT pg_catalog.jsonb_object_agg(
                      constraint_row.conname,
                      pg_catalog.jsonb_build_object(
                        'validated', constraint_row.convalidated,
                        'type', constraint_row.contype,
                        'noInherit', constraint_row.connoinherit,
                        'definition', constraint_row.definition,
                        'expression', constraint_row.expression
                      )
                    )
               FROM constraints AS constraint_row
           ),
           '{}'::JSONB
         ),
         'dataApiPrivilegeCount',
           (SELECT privilege_count FROM data_api_privileges),
         'runtimeEventSelect',
           pg_catalog.has_table_privilege(
             :'app_role',
             'public.agent_mission_events',
             'SELECT'
           ),
         'runtimeEventInsert',
           pg_catalog.has_table_privilege(
             :'app_role',
             'public.agent_mission_events',
             'INSERT'
           ),
         'flagCount', (
           SELECT pg_catalog.count(*)::INTEGER
             FROM public.release_flags AS flag
            WHERE flag.key = 'bob.agent_missions.quote.m2a'
         ),
         'flagOffCount', (
           SELECT pg_catalog.count(*)::INTEGER
             FROM public.release_flags AS flag
            WHERE flag.key = 'bob.agent_missions.quote.m2a'
              AND flag.environment::TEXT IN (
                'development',
                'staging',
                'production'
              )
              AND NOT flag.enabled
              AND NOT flag."killSwitch"
              AND flag.version = 1
         ),
         'enabledSubjectCount', (
           SELECT pg_catalog.count(*)::INTEGER
             FROM public.release_flag_subjects AS subject
             JOIN public.release_flags AS flag
               ON flag.id = subject."flagId"
            WHERE flag.key = 'bob.agent_missions.quote.m2a'
              AND subject.enabled
         )
       )::TEXT;
`;

const FOREIGN_AUTHORITY_SNAPSHOT_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.jsonb_build_object(
  'conversationFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data) ORDER BY row_data."keySpace"),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_key_version_floors AS row_data
  ),
  'conversationBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(row_data)
        ORDER BY row_data."keySpace", row_data."keyVersion"
      ),
      '[]'::JSONB
    )
      FROM public.realtime_mistral_conversation_key_bindings AS row_data
  ),
  'missionFingerprintFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data) ORDER BY row_data."keySpace"),
      '[]'::JSONB
    )
      FROM public.agent_mission_fingerprint_key_version_floors AS row_data
  ),
  'missionFingerprintBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(row_data)
        ORDER BY row_data."keyVersion"
      ),
      '[]'::JSONB
    )
      FROM public.agent_mission_fingerprint_key_bindings AS row_data
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
  ),
  'realtimeCapacity', (
    SELECT pg_catalog.to_jsonb(capacity)
      FROM public.realtime_global_capacity AS capacity
     WHERE capacity.id = 1
  )
)::TEXT;
`;

const FINGERPRINT_WRITER_STATE_SQL = `
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.format(
         '%s|%s|%s',
         floor."minimumWriterVersion",
         CASE WHEN floor."writerEnabled" THEN 'true' ELSE 'false' END,
         CASE WHEN binding."keyVersion" IS NULL THEN 'false' ELSE 'true' END
       )
  FROM public.agent_mission_fingerprint_key_version_floors AS floor
  LEFT JOIN public.agent_mission_fingerprint_key_bindings AS binding
    ON binding."keyVersion" = floor."minimumWriterVersion"
 WHERE floor."keySpace" = 'bob-agent-mission-fingerprint-hmac-v1';
`;

function fail(message) {
  throw new Error(`agent-mission-m2a3-staging-schema:${message}`);
}

function required(environment, name, maximum = 8_192) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function summarizeM2A3PostgresFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  const sqlState =
    /(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/u.exec(text)?.[1] ?? 'unknown';
  const constraint =
    /CONSTRAINT NAME:\s+([A-Za-z_][A-Za-z0-9_]{0,127})/u.exec(text)?.[1];
  const sourceLine =
    /(?:^|\n)LINE\s+([1-9][0-9]{0,8}):/u.exec(text)?.[1];
  const authority =
    /\b(AGENT_MISSION_M2A3_[A-Z0-9_:.-]{1,200})\b/u.exec(text)?.[1];
  return [
    `sqlstate=${sqlState}`,
    ...(sourceLine ? [`line=${sourceLine}`] : []),
    ...(constraint ? [`constraint=${constraint}`] : []),
    ...(authority ? [`authority=${authority}`] : []),
  ].join(',');
}

/** Diagnostic Prisma volontairement borné : aucune ligne SQL, URL ou donnée tenant n'est reprise. */
export function summarizeM2A3PrismaFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (/\bP3009\b/u.test(text)) return 'prisma=P3009';
  if (/\bP3018\b/u.test(text)) return 'prisma=P3018';
  if (/\b(?:55P03|lock timeout|could not obtain lock)\b/iu.test(text)) {
    return 'prisma=lock-timeout';
  }
  if (/\b(?:57014|statement timeout|canceling statement)\b/iu.test(text)) {
    return 'prisma=statement-timeout';
  }
  if (/\b(?:SQLSTATE|database error|migration failed)\b/iu.test(text)) {
    return 'prisma=sql-error';
  }
  return 'prisma=unknown';
}

function phaseDefinition(phase) {
  const definition = M2A3_STAGING_PHASES.find(
    (candidate) => candidate.phase === phase,
  );
  if (definition === undefined) fail('phase must be expand, validate or cutover');
  return definition;
}

export function parseM2A3StagingEnvironment(
  phase,
  environment = process.env,
) {
  const definition = phaseDefinition(phase);
  if (required(environment, 'CABINET_RELEASE_ENV', 16) !== 'staging') {
    fail('this schema gate is staging-only');
  }
  const expectedSha = required(environment, 'BOB_M2A3_EXPECTED_SHA', 40);
  const githubSha = required(environment, 'GITHUB_SHA', 40);
  if (
    !SHA.test(expectedSha)
    || !SHA.test(githubSha)
    || expectedSha !== githubSha
  ) {
    fail('expected SHA must equal the exact GitHub SHA');
  }
  const runId = required(environment, 'GITHUB_RUN_ID', 20);
  const runAttempt = required(environment, 'GITHUB_RUN_ATTEMPT', 10);
  if (!POSITIVE_INTEGER.test(runId) || !POSITIVE_INTEGER.test(runAttempt)) {
    fail('GitHub run identity must be canonical');
  }
  const appRole = required(environment, 'APP_DATABASE_ROLE', 63);
  if (!DATABASE_ROLE.test(appRole)) fail('APP_DATABASE_ROLE must be canonical');
  const previousReceiptDigest = required(
    environment,
    'BOB_M2A3_PREVIOUS_RECEIPT_DIGEST',
    64,
  );
  if (
    (phase === 'expand' && previousReceiptDigest !== 'none')
    || (phase !== 'expand' && !DIGEST.test(previousReceiptDigest))
  ) {
    fail('previous receipt digest is invalid for this phase');
  }
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
  const databaseOid = required(
    environment,
    'BOB_M1B_STAGING_DATABASE_OID',
    10,
  );
  const databaseName = required(
    environment,
    'BOB_M1B_STAGING_DATABASE_NAME',
    63,
  );
  return Object.freeze({
    phase,
    targetState: definition.state,
    targetMigration: definition.migration,
    expectedSha,
    runId,
    runAttempt,
    appRole,
    previousReceiptDigest:
      previousReceiptDigest === 'none' ? null : previousReceiptDigest,
    directUrl: required(environment, 'DIRECT_URL'),
    runtimeUrl: required(environment, 'DATABASE_URL'),
    databasePinHash: sha256(
      `${projectRef}:${systemIdentifier}:${databaseOid}:${databaseName}`,
    ),
    environment,
  });
}

export function parseM2A3MigrationInventory(raw) {
  if (typeof raw !== 'string') fail('migration inventory must be text');
  if (raw.trim() === '') return [];
  const inventory = raw.trim().split('\n').map((line) => {
    const [
      id,
      name,
      checksum,
      finished,
      rolledBack,
      appliedSteps,
      startedAtMicros,
      ...unexpected
    ] = line.split('|');
    if (
      unexpected.length > 0
      || !MIGRATION_ID.test(id ?? '')
      || !MIGRATION_NAME.test(name ?? '')
      || !DIGEST.test(checksum ?? '')
      || !['true', 'false'].includes(finished)
      || !['true', 'false'].includes(rolledBack)
      || !/^(0|[1-9][0-9]{0,9})$/u.test(appliedSteps ?? '')
      || !POSITIVE_INTEGER.test(startedAtMicros ?? '')
    ) {
      fail('migration inventory is malformed');
    }
    if (finished === 'true' && rolledBack === 'true') {
      fail('migration inventory contains an impossible terminal state');
    }
    return Object.freeze({
      id,
      name,
      checksum,
      finished: finished === 'true',
      rolledBack: rolledBack === 'true',
      appliedSteps: Number(appliedSteps),
      startedAtMicros,
    });
  });
  if (new Set(inventory.map(({ id }) => id)).size !== inventory.length) {
    fail('migration inventory contains a duplicate attempt id');
  }
  return inventory;
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

function exactTargetRows(inventory, local) {
  return M2A3_STAGING_PHASES.map(({ migration }) => {
    const rows = inventory.filter(({ name }) => name === migration);
    const expectedChecksum = local.get(migration);
    if (!DIGEST.test(expectedChecksum ?? '')) {
      fail('an exact local M2-A-3 migration is missing');
    }
    if (
      rows.some(
        (row) =>
          row.checksum !== expectedChecksum
          || row.appliedSteps > 1,
      )
    ) {
      fail('M2-A-3 migration attempt is not exact');
    }
    const activeRows = rows.filter(
      ({ finished, rolledBack }) => finished && !rolledBack,
    );
    const unresolvedRows = rows.filter(
      ({ finished, rolledBack }) => !finished && !rolledBack,
    );
    const rolledBackRows = rows.filter(({ rolledBack }) => rolledBack);
    if (
      activeRows.length > 1
      || unresolvedRows.length > 1
      || activeRows.length + unresolvedRows.length > 1
    ) {
      fail('M2-A-3 migration history is ambiguous');
    }
    const active = activeRows[0] ?? null;
    if (
      active !== null
      && active.appliedSteps !== 1
      && !(
        active.appliedSteps === 0
        && rolledBackRows.length > 0
      )
    ) {
      fail('M2-A-3 migration terminal record is not exact');
    }
    return active;
  });
}

function hasActiveHeadForEveryM2A3Phase(inventory) {
  return M2A3_STAGING_PHASES.every(({ migration }) =>
    inventory.some(
      ({ name, finished, rolledBack }) =>
        name === migration && finished && !rolledBack,
    ));
}

function compareMigrationRows(left, right) {
  const timeOrder =
    BigInt(left.startedAtMicros) < BigInt(right.startedAtMicros)
      ? -1
      : BigInt(left.startedAtMicros) > BigInt(right.startedAtMicros)
        ? 1
        : 0;
  return timeOrder || left.id.localeCompare(right.id);
}

function assertM2A3MigrationLineage(inventory, phase) {
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const phaseIndexByMigration = new Map(
    M2A3_STAGING_PHASES.map(({ migration }, index) => [migration, index]),
  );
  const attempts = inventory
    .flatMap((row) => {
      const phaseIndex = phaseIndexByMigration.get(row.name);
      return phaseIndex === undefined
        ? []
        : [{ row, phaseIndex }];
    })
    .sort((left, right) => compareMigrationRows(left.row, right.row));
  if (attempts.some(({ phaseIndex }) => phaseIndex > targetIndex)) {
    fail('M2-A-3 migration history contains a future phase attempt');
  }
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1];
    const current = attempts[index];
    if (
      previous === undefined
      || current === undefined
      || current.phaseIndex < previous.phaseIndex
      || (
        current.phaseIndex !== previous.phaseIndex
        && current.row.startedAtMicros === previous.row.startedAtMicros
      )
    ) {
      fail('M2-A-3 migration chronology is ambiguous');
    }
  }
  for (let phaseIndex = 0; phaseIndex <= targetIndex; phaseIndex += 1) {
    const rows = attempts
      .filter((attempt) => attempt.phaseIndex === phaseIndex)
      .map(({ row }) => row);
    if (rows.length === 0) continue;
    const heads = rows.filter(({ rolledBack }) => !rolledBack);
    if (heads.length > 1) {
      fail('M2-A-3 migration chronology is ambiguous');
    }
    const rolledBackRows = rows.filter(({ rolledBack }) => rolledBack);
    if (rolledBackRows.length > 0) {
      const latestRolledBackStartedAt = rolledBackRows.reduce(
        (latest, row) =>
          BigInt(row.startedAtMicros) > latest
            ? BigInt(row.startedAtMicros)
            : latest,
        BigInt(rolledBackRows[0].startedAtMicros),
      );
      if (
        rolledBackRows.filter(
          (row) => BigInt(row.startedAtMicros) === latestRolledBackStartedAt,
        ).length !== 1
      ) {
        fail('M2-A-3 migration chronology is ambiguous');
      }
    }
    const head = heads[0];
    if (
      head !== undefined
      && rows.some(
        (row) =>
          row.id !== head.id
          && BigInt(row.startedAtMicros) >= BigInt(head.startedAtMicros),
      )
    ) {
      fail('M2-A-3 migration chronology is ambiguous');
    }
    if (phaseIndex === 0) continue;
    const prerequisite = attempts.find(
      (attempt) =>
        attempt.phaseIndex === phaseIndex - 1
        && attempt.row.finished
        && !attempt.row.rolledBack,
    )?.row;
    if (
      prerequisite === undefined
      || rows.some(
        (row) =>
          BigInt(row.startedAtMicros)
          <= BigInt(prerequisite.startedAtMicros),
      )
    ) {
      fail('M2-A-3 migration prerequisite chronology is invalid');
    }
  }
}

function migrationHistorySummary(inventory) {
  const ordered = [...inventory].sort(compareMigrationRows);
  return Object.freeze({
    historyDigest: sha256(JSON.stringify(ordered)),
    rolledBackCount: ordered.filter(({ rolledBack }) => rolledBack).length,
    unresolvedCount: ordered.filter(
      ({ finished, rolledBack }) => !finished && !rolledBack,
    ).length,
  });
}

function migrationAttemptHash(attempt) {
  return sha256([
    attempt.id,
    attempt.name,
    attempt.checksum,
    attempt.startedAtMicros,
  ].join('|'));
}

function migrationRecoveryHistoryDigest(inventory, attempt) {
  // L'intent logique lie tout le préfixe historique qui existait lorsque la tentative a été
  // observée, y compris d'anciens retries de la même migration. Les lignes apparues après le
  // resolve (par exemple le retry Prisma qui a COMMIT avant que le processus tombe) sont exclues :
  // un redémarrage peut ainsi reconstruire le même digest sans effacer une lignée antérieure.
  const immutablePrefix = inventory
    .filter((row) => compareMigrationRows(row, attempt) <= 0)
    .map((row) => ({
      id: row.id,
      name: row.name,
      checksum: row.checksum,
      startedAtMicros: row.startedAtMicros,
    }))
    .sort(compareMigrationRows);
  if (!immutablePrefix.some(({ id }) => id === attempt.id)) {
    fail('migration recovery history is incomplete');
  }
  return sha256(JSON.stringify(immutablePrefix));
}

function assertLocalChecksumPrefix(inventory, local) {
  const active = activeMigrations(inventory);
  try {
    assertAppliedMigrationChecksums({
      applied: active,
      local,
      allowPendingLocal: true,
    });
  } catch {
    fail('migration checksum proof failed');
  }
  const appliedNames = new Set(active.map(({ name }) => name));
  const pending = [...local.keys()]
    .filter((name) => !appliedNames.has(name))
    .sort();
  const permitted = M2A3_STAGING_PHASES.map(({ migration }) => migration);
  if (pending.some((name) => !permitted.includes(name))) {
    fail('a non-M2-A-3 migration is pending');
  }
  return Object.freeze({ active, pending });
}

export function assertM2A3PhasePreflight(
  inventory,
  local,
  phase,
) {
  assertNoUnresolvedMigration(inventory);
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const terminalLineageCandidate =
    hasActiveHeadForEveryM2A3Phase(inventory);
  assertM2A3MigrationLineage(
    inventory,
    terminalLineageCandidate ? 'cutover' : phase,
  );
  const targetRows = exactTargetRows(inventory, local);
  const finalizedTrain = targetRows.every((row) => row !== null);
  const { active, pending } = assertLocalChecksumPrefix(inventory, local);
  const appliedTargetCount = targetRows.filter(Boolean).length;
  for (let index = 0; index < targetRows.length; index += 1) {
    if ((index < appliedTargetCount) !== (targetRows[index] !== null)) {
      fail('M2-A-3 migrations are not an exact prefix');
    }
  }
  let operation;
  if (finalizedTrain) operation = 'recertify';
  else if (appliedTargetCount === targetIndex) operation = 'apply';
  else if (appliedTargetCount === targetIndex + 1) operation = 'recertify';
  else fail('phase cannot certify a past or future schema state');
  const expectedPending = M2A3_STAGING_PHASES
    .slice(appliedTargetCount)
    .map(({ migration }) => migration);
  if (JSON.stringify(pending) !== JSON.stringify(expectedPending)) {
    fail('pending migration suffix is not exact');
  }
  const history = migrationHistorySummary(inventory);
  return Object.freeze({
    operation,
    appliedCount: active.length,
    pendingCount: pending.length,
    ...history,
    targetChecksum: local.get(M2A3_STAGING_PHASES[targetIndex].migration),
    stateBefore: finalizedTrain ? 'S3' : `S${appliedTargetCount}`,
  });
}

export function assertM2A3PhasePostflight(
  inventory,
  local,
  phase,
) {
  assertNoUnresolvedMigration(inventory);
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const terminalLineageCandidate =
    hasActiveHeadForEveryM2A3Phase(inventory);
  assertM2A3MigrationLineage(
    inventory,
    terminalLineageCandidate ? 'cutover' : phase,
  );
  const targetRows = exactTargetRows(inventory, local);
  const finalizedTrain = targetRows.every((row) => row !== null);
  const { active, pending } = assertLocalChecksumPrefix(inventory, local);
  const expectedApplied = finalizedTrain
    ? M2A3_STAGING_PHASES.length
    : targetIndex + 1;
  if (
    targetRows.filter(Boolean).length !== expectedApplied
    || targetRows.some(
      (row, index) => (index < expectedApplied) !== (row !== null),
    )
  ) {
    fail('postflight schema state is not the exact target prefix');
  }
  const expectedPending = M2A3_STAGING_PHASES
    .slice(expectedApplied)
    .map(({ migration }) => migration);
  if (JSON.stringify(pending) !== JSON.stringify(expectedPending)) {
    fail('postflight pending migration suffix is not exact');
  }
  const history = migrationHistorySummary(inventory);
  return Object.freeze({
    appliedCount: active.length,
    pendingCount: pending.length,
    ...history,
    targetChecksum: local.get(M2A3_STAGING_PHASES[targetIndex].migration),
    stateAfter: finalizedTrain ? 'S3' : `S${expectedApplied}`,
  });
}

/**
 * Planifie uniquement la reprise de la migration de la phase courante. Une ligne incomplète
 * étrangère, un préfixe différent ou un schéma qui n'est ni S(n) ni S(n+1) échoue fermé.
 */
export function planM2A3MigrationRecovery(
  inventory,
  local,
  phase,
  observedState,
) {
  const unresolved = inventory.filter(
    ({ finished, rolledBack }) => !finished && !rolledBack,
  );
  if (unresolved.length === 0) return null;
  if (unresolved.length !== 1) {
    fail('migration inventory contains multiple unresolved migrations');
  }
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const target = M2A3_STAGING_PHASES[targetIndex];
  assertM2A3MigrationLineage(inventory, phase);
  const attempt = unresolved[0];
  if (
    attempt.name !== target.migration
    || attempt.checksum !== local.get(target.migration)
  ) {
    fail('unresolved migration is not the exact phase target');
  }
  const attemptStartedAtMicros = BigInt(attempt.startedAtMicros);
  if (
    inventory.some(
      (row) =>
        row.name === attempt.name
        && row.id !== attempt.id
        && BigInt(row.startedAtMicros) >= attemptStartedAtMicros,
    )
  ) {
    fail('unresolved migration is not the latest exact target attempt');
  }
  const targetRows = exactTargetRows(inventory, local);
  const { active, pending } = assertLocalChecksumPrefix(inventory, local);
  const appliedTargetCount = targetRows.filter(Boolean).length;
  if (
    appliedTargetCount !== targetIndex
    || targetRows.some(
      (row, index) => (index < targetIndex) !== (row !== null),
    )
  ) {
    fail('unresolved migration does not follow the exact target prefix');
  }
  const expectedPending = M2A3_STAGING_PHASES
    .slice(targetIndex)
    .map(({ migration }) => migration);
  if (JSON.stringify(pending) !== JSON.stringify(expectedPending)) {
    fail('unresolved migration pending suffix is not exact');
  }
  const stateBefore = `S${targetIndex}`;
  const targetState = target.state;
  const recoveryAction =
    observedState === stateBefore
      ? 'rolled_back'
      : observedState === targetState
        ? 'applied'
        : null;
  if (recoveryAction === null) {
    fail('unresolved migration schema state is not recoverable');
  }
  return Object.freeze({
    recoveryAction,
    recoverySource: 'unresolved',
    attemptId: attempt.id,
    recoveredAttemptHash: migrationAttemptHash(attempt),
    recoveryHistoryDigest:
      migrationRecoveryHistoryDigest(inventory, attempt),
    observedState,
    appliedCount: active.length,
  });
}

function detectCompletedM2A3MigrationRecovery(
  inventory,
  local,
  phase,
) {
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const target = M2A3_STAGING_PHASES[targetIndex];
  assertM2A3MigrationLineage(
    inventory,
    hasActiveHeadForEveryM2A3Phase(inventory) ? 'cutover' : phase,
  );
  exactTargetRows(inventory, local);
  const attempts = inventory
    .filter(
      ({ name, checksum }) =>
        name === target.migration
        && checksum === local.get(target.migration),
    )
    .sort(compareMigrationRows);
  const active = attempts.filter(
    ({ finished, rolledBack }) => finished && !rolledBack,
  );
  const rolledBack = attempts.filter(({ rolledBack }) => rolledBack);
  if (rolledBack.length === 0) return null;
  if (active.length > 1) {
    fail('terminal migration recovery history is ambiguous');
  }
  const activeAttempt = active[0] ?? null;
  const activeStartedAtMicros = activeAttempt === null
    ? null
    : BigInt(activeAttempt.startedAtMicros);
  const rolledBackBeforeActive = activeAttempt === null
    ? rolledBack
    : rolledBack.filter(
      (attempt) =>
        BigInt(attempt.startedAtMicros) < activeStartedAtMicros,
    );
  if (
    rolledBackBeforeActive.length === 0
    || (
      activeAttempt !== null
      && rolledBackBeforeActive.length !== rolledBack.length
    )
  ) {
    fail('terminal migration recovery history is ambiguous');
  }
  // Prisma conserve les retries rolled-back. La tentative récupérée est donc la dernière du
  // préfixe antérieur au record actif éventuel, jamais « l'unique ligne rolled-back ».
  const recoveredAttempt = rolledBackBeforeActive.at(-1);
  if (recoveredAttempt === undefined) {
    fail('terminal migration recovery history is ambiguous');
  }
  const recoveredStartedAtMicros = BigInt(
    recoveredAttempt.startedAtMicros,
  );
  if (
    rolledBackBeforeActive.filter(
      (attempt) =>
        BigInt(attempt.startedAtMicros) === recoveredStartedAtMicros,
    ).length !== 1
  ) {
    fail('terminal migration recovery history is ambiguous');
  }
  const recoveryAction =
    activeAttempt === null
      ? 'rolled_back'
      : activeAttempt.appliedSteps === 0
      ? 'applied'
      : activeAttempt.appliedSteps === 1
        ? 'rolled_back'
        : null;
  if (
    recoveryAction === null
  ) {
    fail('terminal migration recovery history is ambiguous');
  }
  return Object.freeze({
    recoveryAction,
    recoverySource: 'terminal-history',
    attemptId: recoveredAttempt.id,
    recoveredAttemptHash: migrationAttemptHash(recoveredAttempt),
    recoveryHistoryDigest:
      migrationRecoveryHistoryDigest(inventory, recoveredAttempt),
    observedState:
      recoveryAction === 'applied'
        ? target.state
        : `S${targetIndex}`,
    appliedCount: activeMigrations(inventory).length,
  });
}

export function assertM2A3RecoveryResolution(
  before,
  after,
  local,
  phase,
  recovery,
) {
  if (
    recovery === null
    || !['rolled_back', 'applied'].includes(recovery.recoveryAction)
    || recovery.recoverySource !== 'unresolved'
    || !MIGRATION_ID.test(recovery.attemptId ?? '')
    || !DIGEST.test(recovery.recoveredAttemptHash ?? '')
    || !DIGEST.test(recovery.recoveryHistoryDigest ?? '')
  ) {
    fail('migration recovery proof is invalid');
  }
  const original = before.find(({ id }) => id === recovery.attemptId);
  const resolved = after.find(({ id }) => id === recovery.attemptId);
  if (
    original === undefined
    || resolved === undefined
    || original.finished
    || original.rolledBack
    || resolved.finished
    || !resolved.rolledBack
    || migrationAttemptHash(original) !== recovery.recoveredAttemptHash
    || original.name !== resolved.name
    || original.checksum !== resolved.checksum
    || original.appliedSteps !== resolved.appliedSteps
    || original.startedAtMicros !== resolved.startedAtMicros
  ) {
    fail('Prisma did not resolve the exact failed migration attempt');
  }
  const untouchedBefore = before
    .filter(({ id }) => id !== original.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const untouchedAfter = after
    .filter(({ id }) => id !== original.id)
    .filter(({ id }) => !untouchedBefore.some((row) => row.id === id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const persistedAfter = after
    .filter(({ id }) => untouchedBefore.some((row) => row.id === id))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(untouchedBefore) !== JSON.stringify(persistedAfter)) {
    fail('migration recovery changed an unrelated history row');
  }
  if (recovery.recoveryAction === 'rolled_back') {
    if (untouchedAfter.length !== 0 || after.length !== before.length) {
      fail('rolled-back recovery created an unexpected history row');
    }
  } else {
    const expected = M2A3_STAGING_PHASES.find(
      (candidate) => candidate.phase === phase,
    );
    const active = untouchedAfter.filter(
      ({ finished, rolledBack }) => finished && !rolledBack,
    );
    if (
      untouchedAfter.length !== 1
      || active.length !== 1
      || active[0].name !== expected?.migration
      || active[0].checksum !== local.get(expected?.migration)
      || active[0].appliedSteps !== 0
      || BigInt(active[0].startedAtMicros) <= BigInt(original.startedAtMicros)
    ) {
      fail('applied recovery did not create the exact Prisma acknowledgement');
    }
  }
  const preflight = assertM2A3PhasePreflight(after, local, phase);
  const expectedOperation =
    recovery.recoveryAction === 'rolled_back' ? 'apply' : 'recertify';
  if (preflight.operation !== expectedOperation) {
    fail('resolved migration does not map to the expected phase operation');
  }
  return preflight;
}

export function assertM2A3OperationInventoryTransition(
  before,
  after,
  local,
  phase,
  operation,
) {
  const target = M2A3_STAGING_PHASES.find(
    (candidate) => candidate.phase === phase,
  );
  if (target === undefined || !['apply', 'recertify'].includes(operation)) {
    fail('migration operation inventory transition is invalid');
  }
  const beforeIds = new Set(before.map(({ id }) => id));
  const persistedAfter = after
    .filter(({ id }) => beforeIds.has(id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const stableBefore = [...before]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(stableBefore) !== JSON.stringify(persistedAfter)) {
    fail('migration operation changed an existing history row');
  }
  const added = after.filter(({ id }) => !beforeIds.has(id));
  if (operation === 'recertify') {
    if (added.length !== 0 || after.length !== before.length) {
      fail('migration recertification changed Prisma history');
    }
    return;
  }
  const applied = added[0];
  const latestStartedAtMicros = before.reduce(
    (latest, row) => {
      const candidate = BigInt(row.startedAtMicros);
      return candidate > latest ? candidate : latest;
    },
    -1n,
  );
  if (
    added.length !== 1
    || after.length !== before.length + 1
    || applied === undefined
    || applied.name !== target.migration
    || applied.checksum !== local.get(target.migration)
    || !applied.finished
    || applied.rolledBack
    || applied.appliedSteps !== 1
    || BigInt(applied.startedAtMicros) <= latestStartedAtMicros
  ) {
    fail('migration apply did not append the exact target history row');
  }
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
    || state.relations === null
    || typeof state.relations !== 'object'
    || Array.isArray(state.relations)
    || state.constraints === null
    || typeof state.constraints !== 'object'
    || Array.isArray(state.constraints)
  ) {
    fail('schema state is malformed');
  }
  return state;
}

function constraintSummary(constraint) {
  if (constraint === undefined) return null;
  if (
    constraint === null
    || typeof constraint !== 'object'
    || Array.isArray(constraint)
    || typeof constraint.validated !== 'boolean'
    || constraint.type !== 'c'
    || constraint.noInherit !== false
    || typeof constraint.definition !== 'string'
    || constraint.definition.length < 16
    || constraint.definition.length > 512 * 1024
    || typeof constraint.expression !== 'string'
    || constraint.expression.length < 8
    || constraint.expression.length > 512 * 1024
  ) {
    fail('constraint definition is malformed');
  }
  return Object.freeze({
    validated: constraint.validated,
    definitionHash: sha256(constraint.definition),
    expressionHash: sha256(constraint.expression),
  });
}

function extractCheckClause(migrationSql, constraintName) {
  const marker = `ADD CONSTRAINT ${constraintName} CHECK `;
  const first = migrationSql.indexOf(marker);
  if (
    first < 0
    || migrationSql.indexOf(marker, first + marker.length) >= 0
  ) {
    fail('expected CHECK source is not unique');
  }
  const start = first + marker.length;
  const terminator = ') NOT VALID';
  const end = migrationSql.indexOf(terminator, start);
  const clause = end < 0
    ? ''
    : migrationSql.slice(start, end + 1);
  if (
    clause.length < 32
    || clause.length > 512 * 1024
    || !clause.startsWith('((')
    || !clause.endsWith(')')
    || clause.includes(';')
  ) {
    fail('expected CHECK source is malformed');
  }
  return clause;
}

function expectedConstraintQuery(constraintName) {
  return `
SELECT pg_catalog.jsonb_build_object(
         'validated', constraint_catalog.convalidated,
         'type', constraint_catalog.contype,
         'noInherit', constraint_catalog.connoinherit,
         'definition',
           pg_catalog.pg_get_constraintdef(constraint_catalog.oid, TRUE),
         'expression',
           pg_catalog.pg_get_expr(
             constraint_catalog.conbin,
             constraint_catalog.conrelid,
             TRUE
           )
       )::TEXT
  FROM pg_catalog.pg_constraint AS constraint_catalog
 WHERE constraint_catalog.conrelid =
       'pg_temp.bob_m2a3_expected_events'::pg_catalog.regclass
   AND constraint_catalog.conname = '${constraintName}';
`;
}

/**
 * Compile les deux CHECK depuis les migrations commitées sur le même moteur PostgreSQL que
 * staging. La comparaison ne dépend donc ni d'une copie manuelle ni d'un simple nom de contrainte.
 */
export function deriveExpectedM2A3SchemaFingerprints(
  config,
  dependencies = {},
) {
  const prismaDirectory = dependencies.prismaDirectory ?? PRISMA_DIRECTORY;
  const read = dependencies.readFileSync ?? readFileSync;
  const canonicalSql = String(read(join(
    prismaDirectory,
    'migrations',
    M2A2_EXPAND_MIGRATION,
    'migration.sql',
  )));
  const expandedSql = String(read(join(
    prismaDirectory,
    'migrations',
    M2A3_STAGING_PHASES[0].migration,
    'migration.sql',
  )));
  const canonicalClause = extractCheckClause(
    canonicalSql,
    M2A2_DATA_CONSTRAINT,
  );
  const expandedClause = extractCheckClause(
    expandedSql,
    M2A3_DATA_CONSTRAINT,
  );
  const output = securePsql(
    config.directUrl,
    {
      input: `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
CREATE TEMPORARY TABLE bob_m2a3_expected_events (
  "eventType" TEXT NOT NULL,
  "data" JSONB NOT NULL
) ON COMMIT DROP;
ALTER TABLE pg_temp.bob_m2a3_expected_events
  ADD CONSTRAINT bob_m2a3_expected_canonical CHECK ${canonicalClause} NOT VALID;
ALTER TABLE pg_temp.bob_m2a3_expected_events
  VALIDATE CONSTRAINT bob_m2a3_expected_canonical;
ALTER TABLE pg_temp.bob_m2a3_expected_events
  ADD CONSTRAINT bob_m2a3_expected_expanded CHECK ${expandedClause} NOT VALID;
${expectedConstraintQuery('bob_m2a3_expected_canonical')}
${expectedConstraintQuery('bob_m2a3_expected_expanded')}
ALTER TABLE pg_temp.bob_m2a3_expected_events
  VALIDATE CONSTRAINT bob_m2a3_expected_expanded;
${expectedConstraintQuery('bob_m2a3_expected_expanded')}
`,
      label: 'M2-A-3-expected-CHECK-fingerprints',
    },
    config.environment,
    dependencies,
  );
  const rows = output.split('\n').filter(Boolean);
  if (rows.length !== 3) {
    fail('expected CHECK compilation is incomplete');
  }
  const parsed = rows.map((row) => {
    try {
      return constraintSummary(JSON.parse(row));
    } catch {
      fail('expected CHECK compilation is malformed');
    }
  });
  const [canonical, expandedUnvalidated, expandedValidated] = parsed;
  if (
    canonical?.validated !== true
    || expandedUnvalidated?.validated !== false
    || expandedValidated?.validated !== true
    || expandedUnvalidated.expressionHash
      !== expandedValidated.expressionHash
  ) {
    fail('expected CHECK compilation is incoherent');
  }
  const shape = (canonicalConstraint, expandedConstraint) =>
    Object.freeze({
      canonicalConstraintDefinitionHash:
        canonicalConstraint.definitionHash,
      canonicalConstraintExpressionHash:
        canonicalConstraint.expressionHash,
      expandedConstraintDefinitionHash:
        expandedConstraint?.definitionHash ?? null,
      expandedConstraintExpressionHash:
        expandedConstraint?.expressionHash ?? null,
    });
  return Object.freeze({
    S0: shape(canonical, null),
    S1: shape(canonical, expandedUnvalidated),
    S2: shape(canonical, expandedValidated),
    S3: shape(expandedValidated, null),
  });
}

export function assertM2A3SchemaFingerprint(
  schema,
  stateName,
  expectedFingerprints,
) {
  const expected = expectedFingerprints?.[stateName];
  const fields = [
    'canonicalConstraintDefinitionHash',
    'canonicalConstraintExpressionHash',
    'expandedConstraintDefinitionHash',
    'expandedConstraintExpressionHash',
  ];
  if (
    expected === null
    || typeof expected !== 'object'
    || fields.some((field) => schema[field] !== expected[field])
  ) {
    fail('M2-A-3 CHECK semantic fingerprint drifted');
  }
  return schema;
}

export function assertM2A3SchemaState(value, stateName) {
  if (!['S0', 'S1', 'S2', 'S3'].includes(stateName)) {
    fail('schema state name is invalid');
  }
  const state = decodeSchemaState(value);
  const events = state.relations.agent_mission_events;
  const flags = state.relations.release_flags;
  for (const relation of [events, flags]) {
    if (
      relation === null
      || typeof relation !== 'object'
      || Array.isArray(relation)
      || !DATABASE_ROLE.test(relation.owner ?? '')
      || relation.rowSecurity !== true
      || relation.forceRowSecurity !== true
      || relation.deployerCanSetOwner !== true
    ) {
      fail('protected relation authority drifted');
    }
  }
  if (
    state.sessionUser !== 'postgres'
    || state.currentUser !== 'postgres'
    || state.dataApiPrivilegeCount !== 0
    || state.runtimeEventSelect !== true
    || state.runtimeEventInsert !== true
    || state.flagCount !== 3
    || state.flagOffCount !== 3
    || state.enabledSubjectCount !== 0
  ) {
    fail('M2-A-3 RLS, ACL or flag fence drifted');
  }
  const canonical = constraintSummary(
    state.constraints.agent_mission_events_data_check,
  );
  const expanded = constraintSummary(
    state.constraints.agent_mission_events_data_m2a3_check,
  );
  const expected = {
    S0: { canonical: true, canonicalValidated: true, expanded: false },
    S1: { canonical: true, canonicalValidated: true, expanded: true, expandedValidated: false },
    S2: { canonical: true, canonicalValidated: true, expanded: true, expandedValidated: true },
    S3: { canonical: true, canonicalValidated: true, expanded: false },
  }[stateName];
  if (
    (canonical !== null) !== expected.canonical
    || (canonical?.validated ?? null) !== expected.canonicalValidated
    || (expanded !== null) !== expected.expanded
    || (
      expected.expanded
      && expanded?.validated !== expected.expandedValidated
    )
    || Object.keys(state.constraints).some(
      (name) =>
        name !== 'agent_mission_events_data_check'
        && name !== 'agent_mission_events_data_m2a3_check',
    )
  ) {
    fail('M2-A-3 CHECK state drifted');
  }
  return Object.freeze({
    schemaOwner: events.owner,
    releaseFlagsOwner: flags.owner,
    canonicalConstraintDefinitionHash: canonical?.definitionHash ?? null,
    canonicalConstraintExpressionHash: canonical?.expressionHash ?? null,
    expandedConstraintDefinitionHash: expanded?.definitionHash ?? null,
    expandedConstraintExpressionHash: expanded?.expressionHash ?? null,
  });
}

function detectRecoverableM2A3SchemaState(value, phase) {
  const targetIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  if (targetIndex < 0) fail('phase must be expand, validate or cutover');
  const candidates = [`S${targetIndex}`, `S${targetIndex + 1}`];
  const matches = candidates.flatMap((stateName) => {
    try {
      return [{ stateName, schema: assertM2A3SchemaState(value, stateName) }];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) {
    fail('unresolved migration schema state is not exactly recoverable');
  }
  return Object.freeze(matches[0]);
}

export function parseM2A3WriterMatrix(value, stateName) {
  if (!['S0', 'S1', 'S2', 'S3'].includes(stateName)) {
    fail('writer N-1 state is invalid');
  }
  const expected = stateName === 'S3'
    ? 'sealed=accepted|null_pair=accepted|mixed_id_null=rejected|mixed_null_hash=rejected'
    : 'sealed=accepted|null_pair=rejected|mixed_id_null=rejected|mixed_null_hash=rejected';
  if (value !== expected) fail('writer N-1 matrix drifted');
  return Object.freeze(Object.fromEntries(
    value.split('|').map((entry) => entry.split('=')),
  ));
}

function validM2A3WriterMatrix(value, stateName) {
  const expected = {
    sealed: 'accepted',
    null_pair: stateName === 'S3' ? 'accepted' : 'rejected',
    mixed_id_null: 'rejected',
    mixed_null_hash: 'rejected',
  };
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(Object.keys(expected).sort())
    && Object.entries(expected).every(
      ([key, outcome]) => value[key] === outcome,
    )
  );
}

export function parseM2A3FingerprintWriterState(value) {
  const [version, enabled, binding, ...unexpected] = String(value).split('|');
  if (
    unexpected.length > 0
    || !/^[1-9][0-9]{0,9}$/u.test(version ?? '')
    || Number(version) > 2_147_483_647
    || !['true', 'false'].includes(enabled)
    || binding !== 'true'
  ) {
    fail('fingerprint writer state is malformed');
  }
  if (enabled !== 'false') {
    fail('schema-only gate requires the staging fingerprint writer to remain disabled');
  }
  return 'disabled-fence';
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
    '-v',
    'VERBOSITY=verbose',
    ...(singleTransaction ? ['--single-transaction'] : []),
    ...variables.flatMap(([name, value]) => {
      if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name)) {
        fail('psql variable name is invalid');
      }
      return ['-v', `${name}=${value}`];
    }),
    ...(file === undefined ? [] : ['-f', file]),
  ];
  const result = withPsqlChildEnvironment(
    url,
    environment,
    (childEnvironment) => spawn(
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
    fail(
      `PostgreSQL gate ${label} failed (${kind},${
        summarizeM2A3PostgresFailure(String(result.stderr ?? ''))
      })`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function migrationInventory(config, dependencies) {
  return parseM2A3MigrationInventory(securePsql(
    config.directUrl,
    { input: MIGRATION_INVENTORY_SQL, label: 'migration-inventory' },
    config.environment,
    dependencies,
  ));
}

function schemaState(config, dependencies) {
  return securePsql(
    config.directUrl,
    {
      input: SCHEMA_STATE_SQL,
      label: 'schema-state',
      variables: [['app_role', config.appRole]],
    },
    config.environment,
    dependencies,
  );
}

function foreignAuthorityHash(config, dependencies) {
  const snapshot = securePsql(
    config.directUrl,
    {
      input: FOREIGN_AUTHORITY_SNAPSHOT_SQL,
      label: 'foreign-authority-snapshot',
    },
    config.environment,
    dependencies,
  );
  if (snapshot.length < 2 || snapshot.length > 1024 * 1024) {
    fail('foreign authority snapshot is invalid');
  }
  try {
    JSON.parse(snapshot);
  } catch {
    fail('foreign authority snapshot is invalid');
  }
  return sha256(snapshot);
}

function assertNoSymlink(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail('Prisma source contains a symlink');
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) stack.push(join(current, entry));
  }
}

export function stageM2A3PrismaView(
  targetMigration,
  local,
  dependencies = {},
) {
  if (!M2A3_STAGING_PHASES.some(({ migration }) => migration === targetMigration)) {
    fail('target migration is not part of M2-A-3');
  }
  const sourceDirectory = dependencies.prismaDirectory ?? PRISMA_DIRECTORY;
  assertNoSymlink(sourceDirectory);
  const root = (dependencies.mkdtempSync ?? mkdtempSync)(
    join(dependencies.tmpDirectory ?? tmpdir(), 'bob-m2a3-prisma-'),
  );
  chmodSync(root, 0o700);
  const stagedMigrations = join(root, 'migrations');
  mkdirSync(stagedMigrations, { mode: 0o700 });
  cpSync(
    join(sourceDirectory, 'schema.prisma'),
    join(root, 'schema.prisma'),
    { errorOnExist: true, force: false },
  );
  cpSync(
    join(sourceDirectory, 'migrations', 'migration_lock.toml'),
    join(stagedMigrations, 'migration_lock.toml'),
    { errorOnExist: true, force: false },
  );
  const names = [...local.keys()].sort();
  const targetIndex = names.indexOf(targetMigration);
  if (targetIndex < 0) fail('target migration is absent from local inventory');
  for (const name of names.slice(0, targetIndex + 1)) {
    const source = join(sourceDirectory, 'migrations', name);
    if (!lstatSync(source).isDirectory()) fail('migration source is not a directory');
    cpSync(source, join(stagedMigrations, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  return Object.freeze({
    root,
    schemaPath: join(root, 'schema.prisma'),
  });
}

function runPrismaMigrationCommand(
  config,
  local,
  command,
  dependencies = {},
) {
  if (
    command !== 'deploy'
    && command !== 'resolve-rolled-back'
    && command !== 'resolve-applied'
  ) {
    fail('Prisma migration command is not governed');
  }
  const view = stageM2A3PrismaView(
    config.targetMigration,
    local,
    dependencies,
  );
  try {
    const spawn = dependencies.spawnSync ?? spawnSync;
    const prismaArguments = command === 'deploy'
      ? ['migrate', 'deploy', '--schema', view.schemaPath]
      : [
          'migrate',
          'resolve',
          '--schema',
          view.schemaPath,
          command === 'resolve-rolled-back' ? '--rolled-back' : '--applied',
          config.targetMigration,
        ];
    const result = spawn(
      'pnpm',
      [
        '--filter',
        '@bob/api',
        'exec',
        'prisma',
        ...prismaArguments,
      ],
      {
        cwd: REPOSITORY_ROOT,
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
      fail(
        `Prisma migrate command failed (${kind},${
          summarizeM2A3PrismaFailure(String(result.stderr ?? ''))
        })`,
      );
    }
  } finally {
    (dependencies.rmSync ?? rmSync)(view.root, {
      recursive: true,
      force: true,
      maxRetries: 2,
    });
  }
}

export function applyM2A3Migration(config, local, dependencies = {}) {
  runPrismaMigrationCommand(config, local, 'deploy', dependencies);
}

export function resolveM2A3Migration(
  config,
  local,
  recoveryAction,
  dependencies = {},
) {
  if (!['rolled_back', 'applied'].includes(recoveryAction)) {
    fail('Prisma recovery action is not governed');
  }
  runPrismaMigrationCommand(
    config,
    local,
    recoveryAction === 'rolled_back'
      ? 'resolve-rolled-back'
      : 'resolve-applied',
    dependencies,
  );
}

function certifyAcl(config, dependencies) {
  securePsql(
    config.runtimeUrl,
    {
      file: join(
        REPOSITORY_ROOT,
        'apps/api/prisma/agent-missions-release-cert.sql',
      ),
      label: 'agent-mission-acl',
      variables: [['app_role', config.appRole]],
      singleTransaction: false,
    },
    config.environment,
    dependencies,
  );
}

function certifyWriterMatrix(config, stateName, dependencies) {
  return parseM2A3WriterMatrix(securePsql(
    config.runtimeUrl,
    {
      file: join(
        REPOSITORY_ROOT,
        'apps/api/prisma/agent-mission-m2a3-writer-n1-cert.sql',
      ),
      label: 'M2-A-3-writer-N-1-matrix',
      variables: [['state', stateName]],
      singleTransaction: false,
    },
    config.environment,
    dependencies,
  ), stateName);
}

function fingerprintWriterOutcome(config, dependencies) {
  return parseM2A3FingerprintWriterState(securePsql(
    config.directUrl,
    {
      input: FINGERPRINT_WRITER_STATE_SQL,
      label: 'fingerprint-writer-state',
    },
    config.environment,
    dependencies,
  ));
}

export function buildM2A3Evidence({
  status,
  config,
  operation,
  migration,
  stateName,
  schema,
  foreignAuthorityHash: authorityHash,
  runtimeWriterOutcome,
  writerMatrix,
  recovery,
  recoveryIntentDigest = null,
  preflightReceiptDigest,
  observedAt,
}) {
  const recoveryAction = recovery?.recoveryAction ?? null;
  const recoverySource = recovery?.recoverySource ?? null;
  const recoveredAttemptHash = recovery?.recoveredAttemptHash ?? null;
  const recoveryHistoryDigest = recovery?.recoveryHistoryDigest ?? null;
  if (
    !['preflight', 'certified'].includes(status)
    || !['apply', 'recertify'].includes(operation)
    || !DIGEST.test(migration.targetChecksum ?? '')
    || !DIGEST.test(migration.historyDigest ?? '')
    || !Number.isSafeInteger(migration.rolledBackCount)
    || migration.rolledBackCount < 0
    || migration.unresolvedCount !== 0
    || !['S0', 'S1', 'S2', 'S3'].includes(stateName)
    || !DATABASE_ROLE.test(schema.schemaOwner ?? '')
    || !DATABASE_ROLE.test(schema.releaseFlagsOwner ?? '')
    || !DIGEST.test(schema.canonicalConstraintDefinitionHash ?? '')
    || !DIGEST.test(schema.canonicalConstraintExpressionHash ?? '')
    || (
      schema.expandedConstraintDefinitionHash !== null
      && !DIGEST.test(schema.expandedConstraintDefinitionHash)
    )
    || (
      schema.expandedConstraintExpressionHash !== null
      && !DIGEST.test(schema.expandedConstraintExpressionHash)
    )
    || (
      (schema.expandedConstraintDefinitionHash === null)
      !== (schema.expandedConstraintExpressionHash === null)
    )
    || !DIGEST.test(authorityHash ?? '')
    || runtimeWriterOutcome !== 'disabled-fence'
    || !validM2A3WriterMatrix(writerMatrix, stateName)
    || (
      recoveryAction === null
        ? (
            recoverySource !== null
            || recoveredAttemptHash !== null
            || recoveryHistoryDigest !== null
            || recoveryIntentDigest !== null
          )
        : (
            !['rolled_back', 'applied'].includes(recoveryAction)
            || !['unresolved', 'terminal-history'].includes(recoverySource)
            || !DIGEST.test(recoveredAttemptHash ?? '')
            || !DIGEST.test(recoveryHistoryDigest ?? '')
            || !DIGEST.test(recoveryIntentDigest ?? '')
          )
    )
    || (
      status === 'preflight'
      && preflightReceiptDigest !== null
    )
    || (
      status === 'certified'
      && !DIGEST.test(preflightReceiptDigest ?? '')
    )
    || !Number.isFinite(Date.parse(observedAt))
  ) {
    fail('evidence input is invalid');
  }
  return Object.freeze({
    schema: 'bob.agent-mission.m2a3.staging-schema-evidence',
    version: 3,
    status,
    phase: config.phase,
    state: stateName,
    operation,
    releaseSha: config.expectedSha,
    migrationName: config.targetMigration,
    migrationChecksum: migration.targetChecksum,
    appliedMigrationCount: migration.appliedCount,
    pendingMigrationCount: migration.pendingCount,
    migrationHistoryDigest: migration.historyDigest,
    migrationRolledBackCount: migration.rolledBackCount,
    migrationUnresolvedCount: migration.unresolvedCount,
    databasePinHash: config.databasePinHash,
    schemaOwner: schema.schemaOwner,
    releaseFlagsOwner: schema.releaseFlagsOwner,
    canonicalConstraintDefinitionHash:
      schema.canonicalConstraintDefinitionHash,
    canonicalConstraintExpressionHash:
      schema.canonicalConstraintExpressionHash,
    expandedConstraintDefinitionHash:
      schema.expandedConstraintDefinitionHash,
    expandedConstraintExpressionHash:
      schema.expandedConstraintExpressionHash,
    rlsForced: true,
    dataApiClosed: true,
    flagsOff: true,
    runtimeWriterOutcome,
    writerMatrix,
    recoveryAction,
    recoverySource,
    recoveredAttemptHash,
    recoveryHistoryDigest,
    recoveryIntentDigest,
    preflightReceiptDigest,
    foreignAuthorityHash: authorityHash,
    previousReceiptDigest: config.previousReceiptDigest,
    githubRunId: config.runId,
    githubRunAttempt: config.runAttempt,
    observedAt,
  });
}

function recoveryLogicalIntentDigest(intent) {
  return sha256(JSON.stringify({
    schema: 'bob.agent-mission.m2a3.logical-recovery-intent',
    version: 1,
    releaseSha: intent.releaseSha,
    databasePinHash: intent.databasePinHash,
    phase: intent.phase,
    migrationName: intent.migrationName,
    migrationChecksum: intent.migrationChecksum,
    recoveryAction: intent.recoveryAction,
    recoveredAttemptHash: intent.recoveredAttemptHash,
    recoveryHistoryDigest: intent.recoveryHistoryDigest,
    observedState: intent.observedState,
    semanticOracleDigest: intent.semanticOracleDigest,
  }));
}

function buildM2A3RecoveryIntent({
  config,
  recovery,
  currentState,
  schema,
  expectedFingerprints,
  foreignAuthorityHash: authorityHash,
  migrationChecksum,
  observedAt,
}) {
  const semanticOracleDigest = sha256(JSON.stringify(expectedFingerprints));
  if (
    recovery === null
    || !['rolled_back', 'applied'].includes(recovery.recoveryAction)
    || !['unresolved', 'terminal-history'].includes(recovery.recoverySource)
    || !DIGEST.test(recovery.recoveredAttemptHash ?? '')
    || !DIGEST.test(recovery.recoveryHistoryDigest ?? '')
    || !DIGEST.test(semanticOracleDigest)
    || !['S0', 'S1', 'S2', 'S3'].includes(recovery.observedState)
    || !['S0', 'S1', 'S2', 'S3'].includes(currentState)
    || !DIGEST.test(migrationChecksum ?? '')
    || !DIGEST.test(schema.canonicalConstraintDefinitionHash ?? '')
    || !DIGEST.test(schema.canonicalConstraintExpressionHash ?? '')
    || (
      schema.expandedConstraintDefinitionHash !== null
      && !DIGEST.test(schema.expandedConstraintDefinitionHash ?? '')
    )
    || (
      schema.expandedConstraintExpressionHash !== null
      && !DIGEST.test(schema.expandedConstraintExpressionHash ?? '')
    )
    || !DIGEST.test(authorityHash ?? '')
    || !Number.isFinite(Date.parse(observedAt))
  ) {
    fail('migration recovery intent is invalid');
  }
  const intent = {
    schema: 'bob.agent-mission.m2a3.recovery-intent',
    version: 1,
    releaseSha: config.expectedSha,
    phase: config.phase,
    migrationName: config.targetMigration,
    migrationChecksum,
    recoveryAction: recovery.recoveryAction,
    recoverySource: recovery.recoverySource,
    recoveredAttemptHash: recovery.recoveredAttemptHash,
    recoveryHistoryDigest: recovery.recoveryHistoryDigest,
    observedState: recovery.observedState,
    semanticOracleDigest,
    currentState,
    databasePinHash: config.databasePinHash,
    canonicalConstraintDefinitionHash:
      schema.canonicalConstraintDefinitionHash,
    canonicalConstraintExpressionHash:
      schema.canonicalConstraintExpressionHash,
    expandedConstraintDefinitionHash:
      schema.expandedConstraintDefinitionHash,
    expandedConstraintExpressionHash:
      schema.expandedConstraintExpressionHash,
    foreignAuthorityHash: authorityHash,
    githubRunId: config.runId,
    githubRunAttempt: config.runAttempt,
    observedAt,
  };
  return Object.freeze({
    ...intent,
    logicalIntentDigest: recoveryLogicalIntentDigest(intent),
  });
}

function recoveryIntentPath(config, dependencies = {}) {
  const directory = dependencies.evidenceDirectory ?? EVIDENCE_DIRECTORY;
  return join(
    directory,
    `staging-schema-${config.expectedSha}-${config.phase}-recovery-intent.json`,
  );
}

function writeRecoveryIntentAtomically(intent, config, dependencies = {}) {
  const directory = dependencies.evidenceDirectory ?? EVIDENCE_DIRECTORY;
  const mkdir = dependencies.mkdirSync ?? mkdirSync;
  const write = dependencies.writeFileSync ?? writeFileSync;
  const rename = dependencies.renameSync ?? renameSync;
  mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = recoveryIntentPath(config, dependencies);
  const temporaryPath = `${finalPath}.tmp`;
  write(temporaryPath, `${JSON.stringify(intent, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const temporaryFile = openSync(temporaryPath, 'r');
  try {
    fsyncSync(temporaryFile);
  } finally {
    closeSync(temporaryFile);
  }
  rename(temporaryPath, finalPath);
  const directoryFile = openSync(directory, 'r');
  try {
    fsyncSync(directoryFile);
  } finally {
    closeSync(directoryFile);
  }
  return finalPath;
}

function evidencePath(config, status, dependencies = {}) {
  const directory = dependencies.evidenceDirectory ?? EVIDENCE_DIRECTORY;
  return join(
    directory,
    `staging-schema-${config.expectedSha}-${config.phase}-${status}.json`,
  );
}

function writeEvidenceAtomically(evidence, config, dependencies = {}) {
  const directory = dependencies.evidenceDirectory ?? EVIDENCE_DIRECTORY;
  const mkdir = dependencies.mkdirSync ?? mkdirSync;
  const write = dependencies.writeFileSync ?? writeFileSync;
  const rename = dependencies.renameSync ?? renameSync;
  mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = evidencePath(config, evidence.status, dependencies);
  const temporaryPath = `${finalPath}.tmp`;
  write(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  rename(temporaryPath, finalPath);
  return finalPath;
}

export async function runM2A3StagingPhase(
  phase,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM2A3StagingEnvironment(phase, environment);
  (dependencies.certifyDatabase ?? certifyM1BStagingDatabase)(
    environment,
    dependencies,
  );
  const local = await (
    dependencies.readLocalMigrationChecksums
    ?? readLocalMigrationChecksums
  )();
  const expectedFingerprints = (
    dependencies.deriveExpectedSchemaFingerprints
    ?? deriveExpectedM2A3SchemaFingerprints
  )(config, dependencies);
  const initialInventory = (
    dependencies.readMigrationInventory
    ?? migrationInventory
  )(config, dependencies);
  const unresolvedCount = migrationHistorySummary(
    initialInventory,
  ).unresolvedCount;
  let recovery = null;
  let preflight;
  let beforeSchema;
  let beforeAuthority;
  let operationInventory;
  let recoveryIntentDigest = null;
  if (unresolvedCount > 0) {
    const initialSchemaRaw = (
      dependencies.readSchemaState
      ?? schemaState
    )(config, dependencies);
    const detected = detectRecoverableM2A3SchemaState(
      initialSchemaRaw,
      phase,
    );
    assertM2A3SchemaFingerprint(
      detected.schema,
      detected.stateName,
      expectedFingerprints,
    );
    recovery = planM2A3MigrationRecovery(
      initialInventory,
      local,
      phase,
      detected.stateName,
    );
    const initialAuthority = (
      dependencies.foreignAuthorityHash
      ?? foreignAuthorityHash
    )(config, dependencies);
    (dependencies.certifyAcl ?? certifyAcl)(config, dependencies);
    const intent = buildM2A3RecoveryIntent({
        config,
        recovery,
        currentState: detected.stateName,
        schema: detected.schema,
        expectedFingerprints,
        foreignAuthorityHash: initialAuthority,
        migrationChecksum: local.get(config.targetMigration),
        observedAt: new Date().toISOString(),
      });
    writeRecoveryIntentAtomically(
      intent,
      config,
      dependencies,
    );
    recoveryIntentDigest = intent.logicalIntentDigest;
    (dependencies.resolveMigration ?? resolveM2A3Migration)(
      config,
      local,
      recovery.recoveryAction,
      dependencies,
    );
    const resolvedInventory = (
      dependencies.readMigrationInventory
      ?? migrationInventory
    )(config, dependencies);
    preflight = assertM2A3RecoveryResolution(
      initialInventory,
      resolvedInventory,
      local,
      phase,
      recovery,
    );
    operationInventory = resolvedInventory;
    beforeSchema = assertM2A3SchemaFingerprint(
      assertM2A3SchemaState(
        (dependencies.readSchemaState ?? schemaState)(config, dependencies),
        preflight.stateBefore,
      ),
      preflight.stateBefore,
      expectedFingerprints,
    );
    beforeAuthority = (
      dependencies.foreignAuthorityHash
      ?? foreignAuthorityHash
    )(config, dependencies);
    if (beforeAuthority !== initialAuthority) {
      fail('a foreign release authority changed during migration recovery');
    }
  } else {
    operationInventory = initialInventory;
    preflight = assertM2A3PhasePreflight(
      initialInventory,
      local,
      phase,
    );
    beforeSchema = assertM2A3SchemaFingerprint(
      assertM2A3SchemaState(
        (dependencies.readSchemaState ?? schemaState)(config, dependencies),
        preflight.stateBefore,
      ),
      preflight.stateBefore,
      expectedFingerprints,
    );
    beforeAuthority = (
      dependencies.foreignAuthorityHash
      ?? foreignAuthorityHash
    )(config, dependencies);
    recovery = detectCompletedM2A3MigrationRecovery(
      initialInventory,
      local,
      phase,
    );
    if (recovery !== null) {
      const intent = buildM2A3RecoveryIntent({
          config,
          recovery,
          currentState: preflight.stateBefore,
          schema: beforeSchema,
          expectedFingerprints,
          foreignAuthorityHash: beforeAuthority,
          migrationChecksum: local.get(config.targetMigration),
          observedAt: new Date().toISOString(),
        });
      writeRecoveryIntentAtomically(
        intent,
        config,
        dependencies,
      );
      recoveryIntentDigest = intent.logicalIntentDigest;
    }
  }
  (dependencies.certifyAcl ?? certifyAcl)(config, dependencies);
  const beforeWriterMatrix = (
    dependencies.certifyWriterMatrix
    ?? certifyWriterMatrix
  )(config, preflight.stateBefore, dependencies);
  const beforeRuntimeWriterOutcome = (
    dependencies.fingerprintWriterOutcome
    ?? fingerprintWriterOutcome
  )(config, dependencies);
  const preflightPath = writeEvidenceAtomically(buildM2A3Evidence({
    status: 'preflight',
    config,
    operation: preflight.operation,
    migration: preflight,
    stateName: preflight.stateBefore,
    schema: beforeSchema,
    foreignAuthorityHash: beforeAuthority,
    runtimeWriterOutcome: beforeRuntimeWriterOutcome,
    writerMatrix: beforeWriterMatrix,
    recovery,
    recoveryIntentDigest,
    preflightReceiptDigest: null,
    observedAt: new Date().toISOString(),
  }), config, dependencies);
  const preflightReceiptDigest = sha256(readFileSync(preflightPath));

  if (preflight.operation === 'apply') {
    (dependencies.applyMigration ?? applyM2A3Migration)(
      config,
      local,
      dependencies,
    );
  }

  const afterInventory = (
    dependencies.readMigrationInventory
    ?? migrationInventory
  )(config, dependencies);
  assertM2A3OperationInventoryTransition(
    operationInventory,
    afterInventory,
    local,
    phase,
    preflight.operation,
  );
  const postflight = assertM2A3PhasePostflight(
    afterInventory,
    local,
    phase,
  );
  const afterSchema = assertM2A3SchemaFingerprint(
    assertM2A3SchemaState(
      (dependencies.readSchemaState ?? schemaState)(config, dependencies),
      postflight.stateAfter,
    ),
    postflight.stateAfter,
    expectedFingerprints,
  );
  const afterAuthority = (
    dependencies.foreignAuthorityHash
    ?? foreignAuthorityHash
  )(config, dependencies);
  if (afterAuthority !== beforeAuthority) {
    fail('a foreign release authority changed during schema certification');
  }
  (dependencies.certifyAcl ?? certifyAcl)(config, dependencies);
  const writerMatrix = (
    dependencies.certifyWriterMatrix
    ?? certifyWriterMatrix
  )(config, postflight.stateAfter, dependencies);
  const runtimeWriterOutcome = (
    dependencies.fingerprintWriterOutcome
    ?? fingerprintWriterOutcome
  )(config, dependencies);
  const certified = buildM2A3Evidence({
    status: 'certified',
    config,
    operation: preflight.operation,
    migration: postflight,
    stateName: postflight.stateAfter,
    schema: afterSchema,
    foreignAuthorityHash: afterAuthority,
    runtimeWriterOutcome,
    writerMatrix,
    recovery,
    recoveryIntentDigest,
    preflightReceiptDigest,
    observedAt: new Date().toISOString(),
  });
  const certifiedPath = writeEvidenceAtomically(
    certified,
    config,
    dependencies,
  );
  return Object.freeze({
    evidence: certified,
    path: certifiedPath,
    digest: sha256(readFileSync(certifiedPath)),
  });
}

function exactEvidenceKeys() {
  return [
    'schema',
    'version',
    'status',
    'phase',
    'state',
    'operation',
    'releaseSha',
    'migrationName',
    'migrationChecksum',
    'appliedMigrationCount',
    'pendingMigrationCount',
    'migrationHistoryDigest',
    'migrationRolledBackCount',
    'migrationUnresolvedCount',
    'databasePinHash',
    'schemaOwner',
    'releaseFlagsOwner',
    'canonicalConstraintDefinitionHash',
    'canonicalConstraintExpressionHash',
    'expandedConstraintDefinitionHash',
    'expandedConstraintExpressionHash',
    'rlsForced',
    'dataApiClosed',
    'flagsOff',
    'runtimeWriterOutcome',
    'writerMatrix',
    'recoveryAction',
    'recoverySource',
    'recoveredAttemptHash',
    'recoveryHistoryDigest',
    'recoveryIntentDigest',
    'preflightReceiptDigest',
    'foreignAuthorityHash',
    'previousReceiptDigest',
    'githubRunId',
    'githubRunAttempt',
    'observedAt',
  ];
}

function exactRecoveryIntentKeys() {
  return [
    'schema',
    'version',
    'releaseSha',
    'phase',
    'migrationName',
    'migrationChecksum',
    'recoveryAction',
    'recoverySource',
    'recoveredAttemptHash',
    'recoveryHistoryDigest',
    'observedState',
    'semanticOracleDigest',
    'currentState',
    'databasePinHash',
    'canonicalConstraintDefinitionHash',
    'canonicalConstraintExpressionHash',
    'expandedConstraintDefinitionHash',
    'expandedConstraintExpressionHash',
    'foreignAuthorityHash',
    'githubRunId',
    'githubRunAttempt',
    'observedAt',
    'logicalIntentDigest',
  ];
}

export function finalizeM2A3StagingEvidence(
  directory,
  environment = process.env,
  dependencies = {},
) {
  const expectedSha = required(environment, 'BOB_M2A3_EXPECTED_SHA', 40);
  const githubSha = required(environment, 'GITHUB_SHA', 40);
  const runId = required(environment, 'GITHUB_RUN_ID', 20);
  if (
    !SHA.test(expectedSha)
    || expectedSha !== githubSha
    || !POSITIVE_INTEGER.test(runId)
  ) {
    fail('final evidence identity is invalid');
  }
  let previousDigest = null;
  let previousCertified = null;
  let databasePinHash = null;
  let authorityHash = null;
  let schemaOwner = null;
  let releaseFlagsOwner = null;
  let certificationMode = null;
  const certifiedDigests = [];
  const phases = [];
  const expectedMigrationChecksums =
    dependencies.expectedMigrationChecksums
    ?? new Map(M2A3_STAGING_PHASES.map(({ migration }) => [
      migration,
      sha256(readFileSync(join(
        PRISMA_DIRECTORY,
        'migrations',
        migration,
        'migration.sql',
      ))),
    ]));
  for (let index = 0; index < M2A3_STAGING_PHASES.length; index += 1) {
    const definition = M2A3_STAGING_PHASES[index];
    const readReceipt = (status) => {
      const filename =
        `staging-schema-${expectedSha}-${definition.phase}-${status}.json`;
      const bytes = (dependencies.readFileSync ?? readFileSync)(
        join(directory, filename),
      );
      let evidence;
      try {
        evidence = JSON.parse(String(bytes));
      } catch {
        fail(`a ${status} phase receipt is malformed`);
      }
      return Object.freeze({
        bytes,
        digest: sha256(bytes),
        evidence,
      });
    };
    const preflight = readReceipt('preflight');
    const certified = readReceipt('certified');
    for (const [receipt, status] of [
      [preflight.evidence, 'preflight'],
      [certified.evidence, 'certified'],
    ]) {
      if (
        JSON.stringify(Object.keys(receipt).sort())
          !== JSON.stringify(exactEvidenceKeys().sort())
        || receipt.schema
          !== 'bob.agent-mission.m2a3.staging-schema-evidence'
        || receipt.version !== 3
        || receipt.status !== status
        || receipt.phase !== definition.phase
        || receipt.releaseSha !== expectedSha
        || receipt.migrationName !== definition.migration
        || receipt.migrationChecksum
          !== expectedMigrationChecksums.get(definition.migration)
        || receipt.githubRunId !== runId
        || !POSITIVE_INTEGER.test(receipt.githubRunAttempt ?? '')
        || !['apply', 'recertify'].includes(receipt.operation)
        || !DIGEST.test(receipt.migrationChecksum ?? '')
        || !DIGEST.test(receipt.migrationHistoryDigest ?? '')
        || !DIGEST.test(receipt.databasePinHash ?? '')
        || !DATABASE_ROLE.test(receipt.schemaOwner ?? '')
        || !DATABASE_ROLE.test(receipt.releaseFlagsOwner ?? '')
        || !DIGEST.test(receipt.canonicalConstraintDefinitionHash ?? '')
        || !DIGEST.test(receipt.canonicalConstraintExpressionHash ?? '')
        || (
          receipt.expandedConstraintDefinitionHash !== null
          && !DIGEST.test(receipt.expandedConstraintDefinitionHash ?? '')
        )
        || (
          receipt.expandedConstraintExpressionHash !== null
          && !DIGEST.test(receipt.expandedConstraintExpressionHash ?? '')
        )
        || (
          (receipt.expandedConstraintDefinitionHash === null)
          !== (receipt.expandedConstraintExpressionHash === null)
        )
        || !DIGEST.test(receipt.foreignAuthorityHash ?? '')
        || receipt.rlsForced !== true
        || receipt.dataApiClosed !== true
        || receipt.flagsOff !== true
        || !Number.isSafeInteger(receipt.appliedMigrationCount)
        || receipt.appliedMigrationCount < 1
        || !Number.isSafeInteger(receipt.pendingMigrationCount)
        || receipt.pendingMigrationCount < 0
        || !Number.isSafeInteger(receipt.migrationRolledBackCount)
        || receipt.migrationRolledBackCount < 0
        || receipt.migrationUnresolvedCount !== 0
        || (
          receipt.recoveryAction === null
            ? (
                receipt.recoverySource !== null
                ||
                receipt.recoveredAttemptHash !== null
                || receipt.recoveryHistoryDigest !== null
                || receipt.recoveryIntentDigest !== null
              )
            : (
                !['rolled_back', 'applied'].includes(receipt.recoveryAction)
                || !['unresolved', 'terminal-history'].includes(
                  receipt.recoverySource,
                )
                || !DIGEST.test(receipt.recoveredAttemptHash ?? '')
                || !DIGEST.test(receipt.recoveryHistoryDigest ?? '')
                || !DIGEST.test(receipt.recoveryIntentDigest ?? '')
                || receipt.recoveryHistoryDigest
                  === receipt.migrationHistoryDigest
              )
        )
        || !Number.isFinite(Date.parse(receipt.observedAt))
      ) {
        fail(`${status} phase receipt is incomplete`);
      }
    }
    const before = preflight.evidence;
    const after = certified.evidence;
    const finalizedPhaseRecertification =
      before.operation === 'recertify'
      && after.operation === 'recertify'
      && before.state === 'S3'
      && after.state === 'S3'
      && before.pendingMigrationCount === 0
      && after.pendingMigrationCount === 0;
    if (index === 0) {
      certificationMode = finalizedPhaseRecertification
        ? 'finalized-recertification'
        : 'transition-train';
    }
    if (
      certificationMode === 'finalized-recertification'
      && !finalizedPhaseRecertification
    ) {
      fail('finalized recertification is not uniform across phases');
    }
    if (before.recoveryAction !== null) {
      const intentBytes = (dependencies.readFileSync ?? readFileSync)(join(
        directory,
        `staging-schema-${expectedSha}-${definition.phase}-recovery-intent.json`,
      ));
      let intent;
      try {
        intent = JSON.parse(String(intentBytes));
      } catch {
        fail('a recovery intent is malformed');
      }
      const expectedObservedState =
        before.recoveryAction === 'rolled_back'
          ? `S${index}`
          : definition.state;
      if (
        JSON.stringify(Object.keys(intent).sort())
          !== JSON.stringify(exactRecoveryIntentKeys().sort())
        || intent.schema !== 'bob.agent-mission.m2a3.recovery-intent'
        || intent.version !== 1
        || intent.logicalIntentDigest !== before.recoveryIntentDigest
        || recoveryLogicalIntentDigest(intent)
          !== before.recoveryIntentDigest
        || !DIGEST.test(intent.semanticOracleDigest ?? '')
        || intent.releaseSha !== expectedSha
        || intent.phase !== definition.phase
        || intent.migrationName !== definition.migration
        || intent.migrationChecksum !== before.migrationChecksum
        || intent.recoveryAction !== before.recoveryAction
        || intent.recoverySource !== before.recoverySource
        || intent.recoveredAttemptHash !== before.recoveredAttemptHash
        || intent.recoveryHistoryDigest !== before.recoveryHistoryDigest
        || intent.observedState !== expectedObservedState
        || intent.currentState !== before.state
        || intent.databasePinHash !== before.databasePinHash
        || intent.canonicalConstraintDefinitionHash
          !== before.canonicalConstraintDefinitionHash
        || intent.canonicalConstraintExpressionHash
          !== before.canonicalConstraintExpressionHash
        || intent.expandedConstraintDefinitionHash
          !== before.expandedConstraintDefinitionHash
        || intent.expandedConstraintExpressionHash
          !== before.expandedConstraintExpressionHash
        || intent.foreignAuthorityHash !== before.foreignAuthorityHash
        || intent.githubRunId !== before.githubRunId
        || intent.githubRunAttempt !== before.githubRunAttempt
        || !Number.isFinite(Date.parse(intent.observedAt))
        || Date.parse(intent.observedAt) > Date.parse(before.observedAt)
      ) {
        fail('recovery intent is not chained to its phase receipts');
      }
    }
    const finalizedRecertification =
      certificationMode === 'finalized-recertification';
    const expectedBeforeState = finalizedRecertification
      ? 'S3'
      : after.operation === 'apply'
        ? `S${index}`
        : definition.state;
    const expectedAfterState = finalizedRecertification
      ? 'S3'
      : definition.state;
    const expectedPendingMigrationCount = finalizedRecertification
      ? 0
      : M2A3_STAGING_PHASES.length - index - 1;
    if (
      before.operation !== after.operation
      || before.recoveryAction !== after.recoveryAction
      || before.recoverySource !== after.recoverySource
      || before.recoveredAttemptHash !== after.recoveredAttemptHash
      || before.recoveryHistoryDigest !== after.recoveryHistoryDigest
      || before.recoveryIntentDigest !== after.recoveryIntentDigest
      || (
        before.recoveryAction === 'rolled_back'
        && (
          before.recoverySource === 'unresolved'
            ? before.operation !== 'apply'
            : before.recoverySource === 'terminal-history'
              ? !['apply', 'recertify'].includes(before.operation)
              : true
        )
      )
      || (
        before.recoveryAction === 'applied'
        && before.operation !== 'recertify'
      )
      || before.state !== expectedBeforeState
      || after.state !== expectedAfterState
      || before.previousReceiptDigest !== previousDigest
      || after.previousReceiptDigest !== previousDigest
      || before.preflightReceiptDigest !== null
      || after.preflightReceiptDigest !== preflight.digest
      || before.runtimeWriterOutcome !== 'disabled-fence'
      || !validM2A3WriterMatrix(before.writerMatrix, before.state)
      || after.runtimeWriterOutcome !== 'disabled-fence'
      || !validM2A3WriterMatrix(after.writerMatrix, after.state)
      || before.databasePinHash !== after.databasePinHash
      || before.foreignAuthorityHash !== after.foreignAuthorityHash
      || before.schemaOwner !== after.schemaOwner
      || before.releaseFlagsOwner !== after.releaseFlagsOwner
      || before.githubRunAttempt !== after.githubRunAttempt
      || Date.parse(after.observedAt) < Date.parse(before.observedAt)
      || before.migrationRolledBackCount !== after.migrationRolledBackCount
      || after.pendingMigrationCount !== expectedPendingMigrationCount
      || (
        after.operation === 'apply'
        && (
          after.appliedMigrationCount !== before.appliedMigrationCount + 1
          || after.pendingMigrationCount !== before.pendingMigrationCount - 1
          || after.migrationHistoryDigest === before.migrationHistoryDigest
        )
      )
      || (
        after.operation === 'recertify'
        && (
          after.appliedMigrationCount !== before.appliedMigrationCount
          || after.pendingMigrationCount !== before.pendingMigrationCount
          || after.migrationHistoryDigest !== before.migrationHistoryDigest
          || before.canonicalConstraintDefinitionHash
            !== after.canonicalConstraintDefinitionHash
          || before.canonicalConstraintExpressionHash
            !== after.canonicalConstraintExpressionHash
          || before.expandedConstraintDefinitionHash
            !== after.expandedConstraintDefinitionHash
          || before.expandedConstraintExpressionHash
            !== after.expandedConstraintExpressionHash
        )
      )
    ) {
      fail('preflight and certified receipts are not an exact transition pair');
    }
    if (databasePinHash === null) {
      databasePinHash = before.databasePinHash;
      authorityHash = before.foreignAuthorityHash;
      schemaOwner = before.schemaOwner;
      releaseFlagsOwner = before.releaseFlagsOwner;
    } else if (
      before.databasePinHash !== databasePinHash
      || before.foreignAuthorityHash !== authorityHash
      || before.schemaOwner !== schemaOwner
      || before.releaseFlagsOwner !== releaseFlagsOwner
    ) {
      fail('database or release authority changed between phases');
    }
    if (
      after.operation === 'apply'
      && previousCertified !== null
      && (
        before.canonicalConstraintDefinitionHash
          !== previousCertified.canonicalConstraintDefinitionHash
        || before.canonicalConstraintExpressionHash
          !== previousCertified.canonicalConstraintExpressionHash
        || before.expandedConstraintDefinitionHash
          !== previousCertified.expandedConstraintDefinitionHash
        || before.expandedConstraintExpressionHash
          !== previousCertified.expandedConstraintExpressionHash
        || before.state !== previousCertified.state
      )
    ) {
      fail('schema evidence is not contiguous between phases');
    }
    if (
      previousCertified !== null
      && (
        Date.parse(before.observedAt)
          < Date.parse(previousCertified.observedAt)
        || Number(before.githubRunAttempt)
          < Number(previousCertified.githubRunAttempt)
      )
    ) {
      fail('schema evidence chronology regressed between phases');
    }
    if (
      finalizedRecertification
      && previousCertified !== null
      && (
        before.appliedMigrationCount
          !== previousCertified.appliedMigrationCount
        || before.pendingMigrationCount
          !== previousCertified.pendingMigrationCount
        || before.migrationHistoryDigest
          !== previousCertified.migrationHistoryDigest
        || before.migrationRolledBackCount
          !== previousCertified.migrationRolledBackCount
        || before.canonicalConstraintDefinitionHash
          !== previousCertified.canonicalConstraintDefinitionHash
        || before.canonicalConstraintExpressionHash
          !== previousCertified.canonicalConstraintExpressionHash
        || before.expandedConstraintDefinitionHash
          !== previousCertified.expandedConstraintDefinitionHash
        || before.expandedConstraintExpressionHash
          !== previousCertified.expandedConstraintExpressionHash
        || before.state !== previousCertified.state
      )
    ) {
      fail('finalized recertification changed between phases');
    }
    if (
      !finalizedRecertification
      && after.operation === 'recertify'
      && previousCertified !== null
      && (
        (
          definition.phase === 'validate'
          && (
            before.canonicalConstraintDefinitionHash
              !== previousCertified.canonicalConstraintDefinitionHash
            || before.canonicalConstraintExpressionHash
              !== previousCertified.canonicalConstraintExpressionHash
            || before.expandedConstraintDefinitionHash === null
            || before.expandedConstraintExpressionHash === null
            || previousCertified.expandedConstraintDefinitionHash === null
            || previousCertified.expandedConstraintExpressionHash === null
            || before.expandedConstraintExpressionHash
              !== previousCertified.expandedConstraintExpressionHash
          )
        )
        || (
          definition.phase === 'cutover'
          && (
            previousCertified.expandedConstraintDefinitionHash === null
            || previousCertified.expandedConstraintExpressionHash === null
            || before.expandedConstraintDefinitionHash !== null
            || before.expandedConstraintExpressionHash !== null
            || before.canonicalConstraintDefinitionHash
              !== previousCertified.expandedConstraintDefinitionHash
            || before.canonicalConstraintExpressionHash
              !== previousCertified.expandedConstraintExpressionHash
          )
        )
      )
    ) {
      fail('recertified CHECK does not derive from the previous phase');
    }
    if (
      after.operation === 'apply'
      && (
        (
          definition.phase === 'expand'
          && (
            before.expandedConstraintDefinitionHash !== null
            || before.expandedConstraintExpressionHash !== null
            || after.expandedConstraintDefinitionHash === null
            || after.expandedConstraintExpressionHash === null
            || before.canonicalConstraintDefinitionHash
              !== after.canonicalConstraintDefinitionHash
            || before.canonicalConstraintExpressionHash
              !== after.canonicalConstraintExpressionHash
          )
        )
        || (
          definition.phase === 'validate'
          && (
            before.expandedConstraintDefinitionHash === null
            || before.expandedConstraintExpressionHash === null
            || after.expandedConstraintDefinitionHash === null
            || after.expandedConstraintExpressionHash === null
            || before.canonicalConstraintDefinitionHash
              !== after.canonicalConstraintDefinitionHash
            || before.canonicalConstraintExpressionHash
              !== after.canonicalConstraintExpressionHash
            || before.expandedConstraintExpressionHash
              !== after.expandedConstraintExpressionHash
          )
        )
        || (
          definition.phase === 'cutover'
          && (
            before.expandedConstraintDefinitionHash === null
            || before.expandedConstraintExpressionHash === null
            || after.expandedConstraintDefinitionHash !== null
            || after.expandedConstraintExpressionHash !== null
            || after.canonicalConstraintDefinitionHash
              !== before.expandedConstraintDefinitionHash
            || after.canonicalConstraintExpressionHash
              !== before.expandedConstraintExpressionHash
          )
        )
      )
    ) {
      fail('constraint hashes do not prove the expected phase transition');
    }
    certifiedDigests.push(certified.digest);
    phases.push(Object.freeze({
      phase: definition.phase,
      state: after.state,
      operation: after.operation,
      recoveryAction: after.recoveryAction,
      githubRunAttempt: after.githubRunAttempt,
      preflightReceiptDigest: preflight.digest,
      certifiedReceiptDigest: certified.digest,
    }));
    previousCertified = after;
    previousDigest = certified.digest;
  }
  const manifest = Object.freeze({
    schema: 'bob.agent-mission.m2a3.staging-schema-manifest',
    version: 2,
    certificationMode,
    releaseSha: expectedSha,
    githubRunId: runId,
    outcome: 'passed',
    flagsOff: true,
    runtimeWriterOutcome: 'disabled-fence',
    databasePinHash,
    foreignAuthorityHash: authorityHash,
    schemaOwner,
    releaseFlagsOwner,
    phases: Object.freeze(phases),
    finalReceiptDigest: certifiedDigests.at(-1),
  });
  const output = join(
    directory,
    `staging-schema-${expectedSha}-manifest.json`,
  );
  const temporary = `${output}.tmp`;
  (dependencies.writeFileSync ?? writeFileSync)(
    temporary,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  (dependencies.renameSync ?? renameSync)(temporary, output);
  return Object.freeze({ manifest, path: output });
}

async function main() {
  const [command, argument, ...unexpected] = process.argv.slice(2);
  if (unexpected.length > 0) fail('unsupported arguments');
  if (command === 'phase') {
    const result = await runM2A3StagingPhase(argument);
    process.stdout.write(
      `agent-mission-m2a3-staging-schema:ok:${argument}:${result.digest}\n`,
    );
    return;
  }
  if (command === 'finalize') {
    const directory = argument ?? EVIDENCE_DIRECTORY;
    finalizeM2A3StagingEvidence(directory);
    process.stdout.write('agent-mission-m2a3-staging-schema:ok:manifest\n');
    return;
  }
  fail('command must be phase or finalize');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'agent-mission-m2a3-staging-schema:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}
