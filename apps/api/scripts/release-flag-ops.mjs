#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withPsqlChildEnvironment } from './psql-child-environment.mjs';

const OPERATIONS = new Set(['set-global', 'set-kill-switch', 'set-subject', 'remove-subject']);
const ENVIRONMENTS = new Set(['development', 'staging', 'production']);
const SUBJECT_TYPES = new Set(['user', 'cabinet']);
const KEY_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(`release-flag-ops:${message}`);
}

function bool(value, name) {
  if (value !== 'true' && value !== 'false') fail(`${name} must be true or false`);
  return value;
}

function text(value, name, min, max) {
  if (!value || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${name} must contain ${min} to ${max} printable characters`);
  }
  return value;
}

export function parseReleaseFlagArgs(argv) {
  const [operation, ...rest] = argv;
  if (!operation || !OPERATIONS.has(operation)) fail('unknown operation');
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!option?.startsWith('--') || value === undefined) fail('options must be --name value pairs');
    const name = option.slice(2);
    if (name in values) fail(`duplicate option --${name}`);
    values[name] = value;
  }
  const allowed = new Set(['key', 'environment', 'enabled', 'subject-type', 'subject-id', 'actor', 'reason', 'expected-version']);
  for (const name of Object.keys(values)) if (!allowed.has(name)) fail(`unknown option --${name}`);

  const key = text(values.key, 'key', 1, 80);
  if (!KEY_PATTERN.test(key)) fail('key has an invalid format');
  const environment = values.environment;
  if (!ENVIRONMENTS.has(environment)) fail('environment must be development, staging or production');
  const actor = text(values.actor, 'actor', 1, 160);
  const reason = text(values.reason, 'reason', 3, 500);
  const expectedVersionRaw = values['expected-version'];
  const expectedVersion = expectedVersionRaw === undefined ? undefined : Number(expectedVersionRaw);
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    fail('expected-version must be a positive integer');
  }
  const needsEnabled = operation !== 'remove-subject';
  const needsSubject = operation === 'set-subject' || operation === 'remove-subject';
  const enabled = needsEnabled ? bool(values.enabled, 'enabled') : undefined;
  if (!needsEnabled && values.enabled !== undefined) fail('--enabled is not valid for remove-subject');
  const subjectType = needsSubject ? values['subject-type'] : undefined;
  if (needsSubject && !SUBJECT_TYPES.has(subjectType)) fail('subject-type must be user or cabinet');
  const subjectId = needsSubject ? text(values['subject-id'], 'subject-id', 1, 160) : undefined;
  if (!needsSubject && (values['subject-type'] !== undefined || values['subject-id'] !== undefined)) {
    fail('subject options are only valid for subject operations');
  }
  return { operation, key, environment, actor, reason, enabled, subjectType, subjectId, expectedVersion };
}

const EFFECTIVE_CABINET_PREFLIGHT_SQL = `
CREATE TEMP TABLE release_flag_preflight_guard (
  ok boolean NOT NULL CHECK (ok)
) ON COMMIT DROP;
INSERT INTO release_flag_preflight_guard (ok)
SELECT
  NOT :'preflight_live'::boolean
  OR flag."killSwitch"
  OR (
    NOT flag.enabled
    AND NOT EXISTS (
      SELECT 1 FROM release_flag_subjects subject
       WHERE subject."flagId" = flag.id AND subject."subjectType" = 'user' AND subject.enabled
    )
    AND NOT EXISTS (
      SELECT 1 FROM release_flag_subjects subject
       WHERE subject."flagId" = flag.id
         AND subject."subjectType" = 'cabinet'
         AND subject.enabled
         AND (
           NOT (subject."subjectId" = ANY(string_to_array(:'job_ids', ',')))
           OR NOT EXISTS (
             SELECT 1 FROM cabinets cabinet
             JOIN cabinet_members member ON member."cabinetId" = cabinet.id
              WHERE cabinet.id = subject."subjectId"
                AND cabinet.status = 'active'
                AND member."userId" = :'worker_user_id'
                AND member.role = 'admin'
                AND member.status = 'active'
           )
         )
    )
  )
  FROM release_flags flag
 WHERE flag.key = :'key' AND flag.environment = :'environment'::"ReleaseEnvironment";
`;

const GLOBAL_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(:'key' || ':' || :'environment', 2));
WITH locked AS MATERIALIZED (
  SELECT * FROM release_flags
   WHERE key = :'key' AND environment = :'environment'::"ReleaseEnvironment"
     AND (NOT :'enforce_expected'::boolean OR version = :'expected_version'::integer)
   FOR UPDATE
), mutated AS (
  UPDATE release_flags flag
     SET enabled = :'enabled'::boolean,
         version = flag.version + 1,
         "updatedByUserId" = :'actor',
         "updatedAt" = CURRENT_TIMESTAMP
    FROM locked
   WHERE flag.id = locked.id
   RETURNING flag.*
), audited AS (
  INSERT INTO release_flag_audit_events (
    id, "flagId", actor, reason, operation, "beforeState", "afterState"
  )
  SELECT :'audit_id', mutated.id, :'actor', :'reason', 'set-global',
         jsonb_build_object('enabled', locked.enabled, 'killSwitch', locked."killSwitch", 'version', locked.version),
         jsonb_build_object('enabled', mutated.enabled, 'killSwitch', mutated."killSwitch", 'version', mutated.version)
    FROM mutated JOIN locked ON locked.id = mutated.id
  RETURNING "flagId"
)
SELECT "flagId" FROM audited;
${EFFECTIVE_CABINET_PREFLIGHT_SQL}
COMMIT;
`;

const KILL_SWITCH_SQL = GLOBAL_SQL
  .replace("SET enabled = :'enabled'::boolean", "SET \"killSwitch\" = :'enabled'::boolean")
  .replace("'set-global'", "'set-kill-switch'");

const SET_SUBJECT_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(:'key' || ':' || :'environment', 2));
WITH target_cabinet AS MATERIALIZED (
  SELECT cabinet.id FROM cabinets cabinet
   WHERE :'subject_type' = 'cabinet' AND cabinet.id = :'subject_id'
     AND cabinet.status = 'active'
   FOR KEY SHARE OF cabinet
), worker_membership AS MATERIALIZED (
  SELECT member.id
    FROM cabinet_members member
    JOIN target_cabinet ON target_cabinet.id = member."cabinetId"
   WHERE member."userId" = :'worker_user_id'
     AND member.role = 'admin'
     AND member.status = 'active'
   FOR SHARE OF member
), flag_before AS MATERIALIZED (
  SELECT * FROM release_flags
   WHERE key = :'key' AND environment = :'environment'::"ReleaseEnvironment"
     AND (NOT :'enforce_expected'::boolean OR version = :'expected_version'::integer)
     AND (
       :'subject_type' <> 'cabinet'
       OR (
         EXISTS (SELECT 1 FROM target_cabinet)
         AND (NOT :'require_worker'::boolean OR EXISTS (SELECT 1 FROM worker_membership))
       )
     )
   FOR UPDATE
), existing AS MATERIALIZED (
  SELECT subject.* FROM release_flag_subjects subject JOIN flag_before ON flag_before.id = subject."flagId"
   WHERE subject."subjectType" = :'subject_type'::"ReleaseFlagSubjectType"
     AND subject."subjectId" = :'subject_id'
   FOR UPDATE OF subject
), flag_after AS (
  UPDATE release_flags flag
     SET version = flag.version + 1,
         "updatedByUserId" = :'actor',
         "updatedAt" = CURRENT_TIMESTAMP
    FROM flag_before
   WHERE flag.id = flag_before.id
   RETURNING flag.*
), updated AS (
  UPDATE release_flag_subjects subject
     SET enabled = :'enabled'::boolean,
         version = subject.version + 1,
         "updatedByUserId" = :'actor',
         "updatedAt" = CURRENT_TIMESTAMP
    FROM existing, flag_after
   WHERE subject.id = existing.id AND subject."flagId" = flag_after.id
   RETURNING subject.*
), inserted AS (
  INSERT INTO release_flag_subjects (
    id, "flagId", "subjectType", "subjectId", enabled, version, "updatedByUserId", "createdAt", "updatedAt"
  )
  SELECT :'subject_row_id', flag_after.id, :'subject_type'::"ReleaseFlagSubjectType", :'subject_id',
         :'enabled'::boolean, 1, :'actor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM flag_after
   WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING *
), result AS (
  SELECT * FROM updated UNION ALL SELECT * FROM inserted
), audited AS (
  INSERT INTO release_flag_audit_events (
    id, "flagId", actor, reason, operation, "beforeState", "afterState"
  )
  SELECT :'audit_id', flag_after.id, :'actor', :'reason', 'set-subject',
         jsonb_build_object(
           'exists', EXISTS (SELECT 1 FROM existing),
           'subjectType', :'subject_type', 'subjectId', :'subject_id',
           'enabled', (SELECT enabled FROM existing), 'version', (SELECT version FROM existing),
           'flagVersion', flag_before.version
         ),
         jsonb_build_object(
           'exists', true, 'subjectType', result."subjectType", 'subjectId', result."subjectId",
           'enabled', result.enabled, 'version', result.version, 'flagVersion', flag_after.version
         )
    FROM flag_before
    JOIN flag_after ON flag_after.id = flag_before.id
    JOIN result ON result."flagId" = flag_after.id
  RETURNING "flagId"
)
SELECT "flagId" FROM audited;
${EFFECTIVE_CABINET_PREFLIGHT_SQL}
COMMIT;
`;

const REMOVE_SUBJECT_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(:'key' || ':' || :'environment', 2));
WITH flag_before AS MATERIALIZED (
  SELECT * FROM release_flags
   WHERE key = :'key' AND environment = :'environment'::"ReleaseEnvironment"
     AND (NOT :'enforce_expected'::boolean OR version = :'expected_version'::integer)
   FOR UPDATE
), existing AS MATERIALIZED (
  SELECT subject.* FROM release_flag_subjects subject JOIN flag_before ON flag_before.id = subject."flagId"
   WHERE subject."subjectType" = :'subject_type'::"ReleaseFlagSubjectType"
     AND subject."subjectId" = :'subject_id'
   FOR UPDATE OF subject
), flag_after AS (
  UPDATE release_flags flag
     SET version = flag.version + 1,
         "updatedByUserId" = :'actor',
         "updatedAt" = CURRENT_TIMESTAMP
    FROM flag_before
   WHERE flag.id = flag_before.id AND EXISTS (SELECT 1 FROM existing)
   RETURNING flag.*
), removed AS (
  DELETE FROM release_flag_subjects subject USING existing, flag_after
   WHERE subject.id = existing.id AND subject."flagId" = flag_after.id
   RETURNING subject.*
), audited AS (
  INSERT INTO release_flag_audit_events (
    id, "flagId", actor, reason, operation, "beforeState", "afterState"
  )
  SELECT :'audit_id', flag_after.id, :'actor', :'reason', 'remove-subject',
         jsonb_build_object(
           'exists', true, 'subjectType', removed."subjectType", 'subjectId', removed."subjectId",
           'enabled', removed.enabled, 'version', removed.version, 'flagVersion', flag_before.version
         ),
         jsonb_build_object(
           'exists', false, 'subjectType', :'subject_type', 'subjectId', :'subject_id',
           'flagVersion', flag_after.version
         )
    FROM flag_before
    JOIN flag_after ON flag_after.id = flag_before.id
    JOIN removed ON removed."flagId" = flag_after.id
  RETURNING "flagId"
)
SELECT "flagId" FROM audited;
${EFFECTIVE_CABINET_PREFLIGHT_SQL}
COMMIT;
`;

export function sqlForReleaseFlagOperation(operation) {
  if (operation === 'set-global') return GLOBAL_SQL;
  if (operation === 'set-kill-switch') return KILL_SWITCH_SQL;
  if (operation === 'set-subject') return SET_SUBJECT_SQL;
  if (operation === 'remove-subject') return REMOVE_SUBJECT_SQL;
  fail('unknown operation');
}

function validateDirectUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('DIRECT_URL must be a valid PostgreSQL URL');
  }
  const user = decodeURIComponent(parsed.username);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('DIRECT_URL must use PostgreSQL');
  if (user !== 'postgres' && !user.startsWith('postgres.')) fail('DIRECT_URL must use the privileged migration role');
  return raw;
}

export function validateCabinetPilotActivation(input, environment = process.env) {
  if (input.key !== 'cabinet.slice0' || input.environment === 'development') return;
  const workerCabinets = new Set((environment.JOB_CABINET_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  if (workerCabinets.size > 100) fail('JOB_CABINET_IDS is limited to 100 distinct pilot cabinets');
  if (input.enabled !== 'true') return;
  if (input.operation === 'set-global') {
    fail('cabinet.slice0 cannot be globally enabled while invitation retention is pilot-scoped');
  }
  if (input.operation !== 'set-subject') return;
  if (input.subjectType !== 'cabinet') {
    fail('live cabinet.slice0 activation must target a cabinet, not a user');
  }
  if (environment.CABINET_INVITATION_WORKER_ENABLED !== 'true') {
    fail('live cabinet.slice0 activation requires the invitation worker');
  }
  const workerUserId = (environment.CABINET_INVITATION_WORKER_USER_ID ?? '').trim();
  if (!UUID_PATTERN.test(workerUserId)) {
    fail('live cabinet.slice0 activation requires a UUID worker principal');
  }
  if (!workerCabinets.has(input.subjectId)) {
    fail('pilot cabinet must be present in JOB_CABINET_IDS before activation');
  }
  return workerUserId;
}

export function runReleaseFlagOperation(input, dependencies = {}) {
  const operationEnvironment = dependencies.environment ?? process.env;
  const activationWorkerUserId = validateCabinetPilotActivation(input, operationEnvironment);
  const configuredWorkerUserId = UUID_PATTERN.test((operationEnvironment.CABINET_INVITATION_WORKER_USER_ID ?? '').trim())
    ? operationEnvironment.CABINET_INVITATION_WORKER_USER_ID.trim()
    : undefined;
  const directUrl = validateDirectUrl(dependencies.directUrl ?? process.env.DIRECT_URL ?? '');
  const spawn = dependencies.spawnSync ?? spawnSync;
  const variables = {
    key: input.key,
    environment: input.environment,
    actor: input.actor,
    reason: input.reason,
    enforce_expected: String(input.expectedVersion !== undefined),
    expected_version: String(input.expectedVersion ?? 1),
    require_worker: String(Boolean(activationWorkerUserId)),
    worker_user_id: configuredWorkerUserId ?? '00000000-0000-4000-8000-000000000000',
    job_ids: operationEnvironment.JOB_CABINET_IDS ?? '',
    preflight_live: String(
      (input.key === 'cabinet.slice0' && input.environment !== 'development')
      || (input.key === 'cabinet.cert-live' && operationEnvironment.BOB_INTERNAL_RELEASE_FLAG_PREFLIGHT_CERT === 'true'),
    ),
    audit_id: randomUUID(),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.subjectType ? { subject_type: input.subjectType } : {}),
    ...(input.subjectId ? { subject_id: input.subjectId, subject_row_id: randomUUID() } : {}),
  };
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  const result = withPsqlChildEnvironment(
    directUrl,
    operationEnvironment,
    (childEnvironment) =>
      spawn('psql', args, {
        input: sqlForReleaseFlagOperation(input.operation),
        encoding: 'utf8',
        env: childEnvironment,
      }),
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed').replaceAll(directUrl, '[redacted]').trim();
    fail(`database operation failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  if (!String(result.stdout).trim()) fail('flag or subject target was not found');
}

function main() {
  const input = parseReleaseFlagArgs(process.argv.slice(2));
  runReleaseFlagOperation(input);
  console.log(`release-flag-ops:ok:${input.operation}:${input.key}:${input.environment}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'release-flag-ops:unknown error');
    process.exitCode = 1;
  }
}
