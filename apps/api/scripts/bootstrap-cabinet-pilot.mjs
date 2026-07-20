#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(`bootstrap-cabinet-pilot:${message}`);
}

function printable(value, name, min, max) {
  if (!value || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${name} must contain ${min} to ${max} printable characters`);
  }
  return value;
}

export function parsePilotArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) fail('options must be --name value pairs');
    const name = option.slice(2);
    if (name in values) fail(`duplicate option --${name}`);
    values[name] = value;
  }
  const allowed = new Set([
    'cabinet-id', 'name', 'time-zone', 'founder-user-id', 'worker-user-id',
    'environment', 'expected-flag-version', 'actor', 'reason',
  ]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) fail(`unknown option --${name}`);
  const cabinetId = values['cabinet-id'];
  const founderUserId = values['founder-user-id'];
  const workerUserId = values['worker-user-id'];
  if (!UUID.test(cabinetId ?? '')) fail('cabinet-id must be a UUID');
  if (!UUID.test(founderUserId ?? '')) fail('founder-user-id must be a UUID');
  if (!UUID.test(workerUserId ?? '')) fail('worker-user-id must be a UUID');
  if (founderUserId === workerUserId) fail('founder and worker must be distinct identities');
  const environment = values.environment;
  if (environment !== 'staging' && environment !== 'production') fail('environment must be staging or production');
  const expectedFlagVersion = Number(values['expected-flag-version']);
  if (!Number.isInteger(expectedFlagVersion) || expectedFlagVersion < 1) fail('expected-flag-version must be positive');
  return {
    cabinetId,
    name: printable(values.name, 'name', 2, 120),
    timeZone: printable(values['time-zone'] ?? 'Europe/Paris', 'time-zone', 1, 64),
    founderUserId,
    workerUserId,
    environment,
    expectedFlagVersion,
    actor: printable(values.actor, 'actor', 1, 160),
    reason: printable(values.reason, 'reason', 3, 500),
  };
}

export function validatePilotEnvironment(input, environment = process.env) {
  if (environment.CABINET_INVITATION_WORKER_ENABLED !== 'true') fail('invitation worker must be enabled');
  if (environment.CABINET_INVITATION_WORKER_USER_ID !== input.workerUserId) fail('worker identity does not match deployment');
  const cabinets = new Set((environment.JOB_CABINET_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  if (cabinets.size > 100) fail('JOB_CABINET_IDS is limited to 100 distinct pilots');
  if (!cabinets.has(input.cabinetId)) fail('cabinet must be listed in JOB_CABINET_IDS before bootstrap');
}

export const PILOT_BOOTSTRAP_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(:'flag_key' || ':' || :'environment', 2));
CREATE TEMP TABLE pilot_assertion (ok boolean NOT NULL CHECK (ok)) ON COMMIT DROP;

INSERT INTO cabinets (
  id, name, "timeZone", status, "createdByUserId", "bootstrapCompletedAt", version, "createdAt", "updatedAt"
) VALUES (
  :'cabinet_id', :'cabinet_name', :'time_zone', 'active', :'founder_user_id', NULL, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pilot_assertion
SELECT EXISTS (
  SELECT 1 FROM cabinets
   WHERE id = :'cabinet_id' AND name = :'cabinet_name' AND "timeZone" = :'time_zone'
     AND status = 'active' AND "createdByUserId" = :'founder_user_id'
);

INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES
  (:'founder_member_id', :'cabinet_id', :'founder_user_id', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (:'worker_member_id', :'cabinet_id', :'worker_user_id', NULL, 'admin', 'active', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pilot_assertion
SELECT
  EXISTS (
    SELECT 1 FROM cabinet_members
     WHERE "cabinetId" = :'cabinet_id' AND "userId" = :'founder_user_id'
       AND role = 'admin' AND status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM cabinet_members
     WHERE "cabinetId" = :'cabinet_id' AND "userId" = :'worker_user_id'
       AND role = 'admin' AND status = 'active'
  );

UPDATE cabinets
   SET "bootstrapCompletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = :'cabinet_id' AND "bootstrapCompletedAt" IS NULL;

INSERT INTO cabinet_audit_events (
  id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload, "createdAt"
) VALUES (
  :'cabinet_audit_id', :'cabinet_id', :'founder_user_id', 'CabinetCreated', 'cabinet', :'cabinet_id',
  jsonb_build_object(
    'type', 'CabinetCreated', 'cabinetId', :'cabinet_id', 'founderUserId', :'founder_user_id',
    'provisionedBy', :'actor', 'reason', :'reason'
  ),
  CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO NOTHING;

SELECT id FROM release_flags
 WHERE key = :'flag_key' AND environment = :'environment'::"ReleaseEnvironment"
 FOR UPDATE;
CREATE TEMP TABLE pilot_flag_before ON COMMIT DROP AS
SELECT * FROM release_flags
 WHERE key = :'flag_key' AND environment = :'environment'::"ReleaseEnvironment";
CREATE TEMP TABLE pilot_subject_before ON COMMIT DROP AS
SELECT subject.* FROM release_flag_subjects subject JOIN pilot_flag_before flag ON flag.id = subject."flagId"
 WHERE subject."subjectType" = 'cabinet' AND subject."subjectId" = :'cabinet_id';

INSERT INTO pilot_assertion
SELECT COALESCE((
  SELECT
    EXISTS (SELECT 1 FROM pilot_subject_before WHERE enabled)
    OR version = :'expected_flag_version'::integer
  FROM pilot_flag_before
), false);

UPDATE release_flags flag
   SET version = flag.version + 1, "updatedByUserId" = :'actor', "updatedAt" = CURRENT_TIMESTAMP
  FROM pilot_flag_before before
 WHERE flag.id = before.id
   AND NOT EXISTS (SELECT 1 FROM pilot_subject_before WHERE enabled);

INSERT INTO release_flag_subjects (
  id, "flagId", "subjectType", "subjectId", enabled, version, "updatedByUserId", "createdAt", "updatedAt"
)
SELECT :'flag_subject_id', flag.id, 'cabinet', :'cabinet_id', true, 1, :'actor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM pilot_flag_before flag
 WHERE NOT EXISTS (SELECT 1 FROM pilot_subject_before WHERE enabled)
ON CONFLICT ("flagId", "subjectType", "subjectId") DO UPDATE
SET enabled = true,
    version = release_flag_subjects.version + 1,
    "updatedByUserId" = :'actor',
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO release_flag_audit_events (
  id, "flagId", actor, reason, operation, "beforeState", "afterState"
)
SELECT :'flag_audit_id', flag.id, :'actor', :'reason', 'set-subject',
       jsonb_build_object(
         'exists', EXISTS (SELECT 1 FROM pilot_subject_before),
         'subjectType', 'cabinet', 'subjectId', :'cabinet_id',
         'enabled', (SELECT enabled FROM pilot_subject_before),
         'version', (SELECT version FROM pilot_subject_before),
         'flagVersion', flag.version
       ),
       jsonb_build_object(
         'exists', true, 'subjectType', 'cabinet', 'subjectId', :'cabinet_id',
         'enabled', true,
         'version', (SELECT version FROM release_flag_subjects WHERE "flagId" = flag.id AND "subjectType" = 'cabinet' AND "subjectId" = :'cabinet_id'),
         'flagVersion', (SELECT version FROM release_flags WHERE id = flag.id)
       )
  FROM pilot_flag_before flag
 WHERE NOT EXISTS (SELECT 1 FROM pilot_subject_before WHERE enabled);

INSERT INTO pilot_assertion
SELECT
  cabinet.status = 'active'
  AND cabinet."bootstrapCompletedAt" IS NOT NULL
  AND guard."activeCount" >= 2
  AND subject.enabled
  AND worker.role = 'admin' AND worker.status = 'active'
  FROM cabinets cabinet
  JOIN cabinet_admin_guards guard ON guard."cabinetId" = cabinet.id
  JOIN cabinet_members worker ON worker."cabinetId" = cabinet.id AND worker."userId" = :'worker_user_id'
  JOIN release_flags flag ON flag.key = :'flag_key' AND flag.environment = :'environment'::"ReleaseEnvironment"
  JOIN release_flag_subjects subject ON subject."flagId" = flag.id AND subject."subjectType" = 'cabinet' AND subject."subjectId" = cabinet.id
 WHERE cabinet.id = :'cabinet_id';

SELECT :'cabinet_id';
COMMIT;
`;

function privilegedUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail('DIRECT_URL must be a PostgreSQL URL'); }
  const user = decodeURIComponent(parsed.username);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || (user !== 'postgres' && !user.startsWith('postgres.'))) {
    fail('DIRECT_URL must use the privileged postgres role');
  }
  return raw;
}

export function bootstrapPilot(input, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  validatePilotEnvironment(input, environment);
  const directUrl = privilegedUrl(dependencies.directUrl ?? process.env.DIRECT_URL ?? '');
  const certMode = environment.BOB_INTERNAL_CABINET_BOOTSTRAP_CERT === 'true';
  const flagKey = certMode ? 'cabinet.cert-bootstrap' : 'cabinet.slice0';
  const variables = {
    cabinet_id: input.cabinetId,
    cabinet_name: input.name,
    time_zone: input.timeZone,
    founder_user_id: input.founderUserId,
    worker_user_id: input.workerUserId,
    environment: input.environment,
    expected_flag_version: String(input.expectedFlagVersion),
    actor: input.actor,
    reason: input.reason,
    flag_key: flagKey,
    founder_member_id: `ops:founder:${input.cabinetId}`,
    worker_member_id: `ops:worker:${input.cabinetId}`,
    cabinet_audit_id: `ops:cabinet-created:${input.cabinetId}`,
    flag_subject_id: `ops:flag-subject:${input.cabinetId}:${input.environment}`,
    flag_audit_id: randomUUID(),
  };
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  args.push(directUrl);
  const result = (dependencies.spawnSync ?? spawnSync)('psql', args, {
    input: PILOT_BOOTSTRAP_SQL,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0 || !String(result.stdout).includes(input.cabinetId)) {
    const diagnostic = String(result.stderr || 'psql failed').replaceAll(directUrl, '[redacted]').trim();
    fail(`transaction failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
}

function main() {
  const input = parsePilotArgs(process.argv.slice(2));
  bootstrapPilot(input);
  console.log(`bootstrap-cabinet-pilot:ok:${input.cabinetId}:${input.environment}`);
}

if (process.argv[1]?.endsWith('bootstrap-cabinet-pilot.mjs')) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'bootstrap-cabinet-pilot:unknown error');
    process.exitCode = 1;
  }
}
