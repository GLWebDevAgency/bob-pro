#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  certifyM1BStagingDatabase,
  parseM1BStagingDatabaseEnvironment,
} from './agent-mission-m1b-staging-database.mjs';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';
import { runReleaseFlagOperation } from './release-flag-ops.mjs';

const FLAG_KEY = 'bob.agent_missions.quote.m2a';
const LEGACY_FLAG_KEY = 'bob.agent_missions.quote.v1';
const FLAG_ENVIRONMENT = 'staging';
const ACTOR = 'system:github:agent-mission-m2a3-staging-preview';
const SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const GITHUB_ACTOR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\[bot\])?$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const EMERGENCY_KILL_MAX_ATTEMPTS = 3;

const FLAG_STATE_SQL = `
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
WITH m2a AS (
SELECT pg_catalog.jsonb_build_object(
  'version', flag.version,
  'enabled', flag.enabled,
  'killSwitch', flag."killSwitch",
  'subjectCount', count(subject.id),
  'enabledSubjectCount', count(subject.id) FILTER (WHERE subject.enabled),
  'updatedBy', flag."updatedByUserId",
  'targetExists', count(subject.id) FILTER (
    WHERE subject."subjectType" = 'user'::public."ReleaseFlagSubjectType"
      AND subject."subjectId" = :'subject_id'
  ) = 1,
  'targetEnabled', coalesce(
    bool_or(subject.enabled) FILTER (
      WHERE subject."subjectType" = 'user'::public."ReleaseFlagSubjectType"
        AND subject."subjectId" = :'subject_id'
    ),
    false
  ),
  'targetActor', max(subject."updatedByUserId") FILTER (
    WHERE subject."subjectType" = 'user'::public."ReleaseFlagSubjectType"
      AND subject."subjectId" = :'subject_id'
  )
) AS state
  FROM public.release_flags AS flag
  LEFT JOIN public.release_flag_subjects AS subject
    ON subject."flagId" = flag.id
 WHERE flag.key = '${FLAG_KEY}'
   AND flag.environment = '${FLAG_ENVIRONMENT}'::public."ReleaseEnvironment"
 GROUP BY flag.id, flag.version, flag.enabled, flag."killSwitch", flag."updatedByUserId"
), legacy_v1 AS (
  SELECT pg_catalog.jsonb_build_object(
    'version', flag.version,
    'enabled', flag.enabled,
    'killSwitch', flag."killSwitch",
    'subjectCount', count(subject.id),
    'enabledSubjectCount', count(subject.id) FILTER (WHERE subject.enabled),
    'updatedBy', flag."updatedByUserId"
  ) AS state
    FROM public.release_flags AS flag
    LEFT JOIN public.release_flag_subjects AS subject
      ON subject."flagId" = flag.id
   WHERE flag.key = '${LEGACY_FLAG_KEY}'
     AND flag.environment = '${FLAG_ENVIRONMENT}'::public."ReleaseEnvironment"
   GROUP BY flag.id, flag.version, flag.enabled, flag."killSwitch", flag."updatedByUserId"
)
SELECT m2a.state || pg_catalog.jsonb_build_object('legacyV1', legacy_v1.state)
  FROM m2a CROSS JOIN legacy_v1;
ROLLBACK;
`;

function fail(message) {
  throw new Error(`agent-mission-m2a3-staging-preview-flag:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 500 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function validateDirectUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('DIRECT_URL must be a valid PostgreSQL URL');
  }
  const user = decodeURIComponent(parsed.username);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    (user !== 'postgres' && !user.startsWith('postgres.'))
  ) {
    fail('DIRECT_URL must use the privileged migration role');
  }
  return value;
}

function calendarDate(value) {
  if (!ISO_DATE.test(value)) {
    fail('BOB_M2A3_STAGING_FOUNDER_AUTH_DATE must use YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('BOB_M2A3_STAGING_FOUNDER_AUTH_DATE is not a calendar date');
  }
  return value;
}

export function parseM2A3StagingPreviewFlagEnvironment(
  environment = process.env,
  command = 'activate',
) {
  const needsCanaryIdentity = new Set(['enable-canary', 'disable-canary', 'assert-canary']).has(
    command,
  );
  const rawUserId = environment.BOB_M2A3_STAGING_USER_ID;
  const userId =
    typeof rawUserId === 'string' && rawUserId.length > 0
      ? required(environment, 'BOB_M2A3_STAGING_USER_ID', { maximum: 80 })
      : NIL_UUID;
  if (!UUID.test(userId) || (needsCanaryIdentity && userId === NIL_UUID)) {
    fail('BOB_M2A3_STAGING_USER_ID must be a non-nil UUID for canary commands');
  }
  const runId = required(environment, 'BOB_M2A3_STAGING_RUN_ID', { maximum: 20 });
  if (!RUN_ID.test(runId)) fail('BOB_M2A3_STAGING_RUN_ID must be github.run_id');
  const runAttempt = required(environment, 'BOB_M2A3_STAGING_RUN_ATTEMPT', { maximum: 10 });
  if (!RUN_ID.test(runAttempt)) fail('BOB_M2A3_STAGING_RUN_ATTEMPT must be github.run_attempt');
  const initiator = required(environment, 'BOB_M2A3_STAGING_INITIATOR', { maximum: 50 });
  if (!GITHUB_ACTOR.test(initiator)) fail('BOB_M2A3_STAGING_INITIATOR must be github.actor');
  const repository = required(environment, 'BOB_M2A3_STAGING_REPOSITORY', { maximum: 150 });
  if (!GITHUB_REPOSITORY.test(repository)) {
    fail('BOB_M2A3_STAGING_REPOSITORY must be github.repository');
  }
  const releaseSha = required(environment, 'BOB_M2A3_STAGING_RELEASE_SHA', { maximum: 40 });
  if (!SHA.test(releaseSha)) fail('BOB_M2A3_STAGING_RELEASE_SHA must be an exact SHA');
  const needsActivationAuthorization = new Set(['enable-canary', 'activate']).has(command);
  const reason = [
    'M2-A-3 staging preview',
    `initiateur=${initiator}`,
    `repository=${repository}`,
    `sha=${releaseSha}`,
    `run=${runId}`,
    `attempt=${runAttempt}`,
    `url=https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  ].join('; ');
  let authorizationReason = '';
  if (needsActivationAuthorization) {
    const founderDate = calendarDate(
      required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_DATE', { maximum: 10 }),
    );
    const founderChannel = required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL', {
      minimum: 2,
      maximum: 40,
    });
    const founderReference = required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_REF', {
      minimum: 3,
      maximum: 120,
    });
    const claudeReference = required(environment, 'BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF', {
      minimum: 3,
      maximum: 120,
    });
    const gptReference = required(environment, 'BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF', {
      minimum: 3,
      maximum: 120,
    });
    authorizationReason = [
      `autorisé=${founderDate}`,
      `canal=${founderChannel}`,
      `référence=${founderReference}`,
      `Claude=${claudeReference}`,
      `GPT=${gptReference}`,
    ].join('; ');
  }
  const auditedReason =
    authorizationReason.length > 0 ? `${reason}; ${authorizationReason}` : reason;
  if (auditedReason.length > 500) fail('the composed release-flag audit reason is too long');
  return Object.freeze({
    directUrl: validateDirectUrl(required(environment, 'DIRECT_URL', { maximum: 8_192 })),
    releaseSha,
    runId,
    runAttempt,
    initiator,
    repository,
    userId,
    actor: ACTOR,
    reason: auditedReason,
  });
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  return value;
}

export function decodeM2A3StagingPreviewFlagState(value) {
  let payload;
  try {
    payload = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('database returned invalid flag JSON');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !Number.isSafeInteger(payload.version) ||
    payload.version < 1 ||
    typeof payload.enabled !== 'boolean' ||
    typeof payload.killSwitch !== 'boolean' ||
    (payload.updatedBy !== null && typeof payload.updatedBy !== 'string') ||
    typeof payload.targetExists !== 'boolean' ||
    typeof payload.targetEnabled !== 'boolean' ||
    (payload.targetActor !== null && typeof payload.targetActor !== 'string') ||
    typeof payload.legacyV1 !== 'object' ||
    payload.legacyV1 === null ||
    Array.isArray(payload.legacyV1) ||
    !Number.isSafeInteger(payload.legacyV1.version) ||
    payload.legacyV1.version < 1 ||
    typeof payload.legacyV1.enabled !== 'boolean' ||
    typeof payload.legacyV1.killSwitch !== 'boolean' ||
    (payload.legacyV1.updatedBy !== null && typeof payload.legacyV1.updatedBy !== 'string')
  ) {
    fail('database returned an invalid flag state');
  }
  const state = Object.freeze({
    version: payload.version,
    enabled: payload.enabled,
    killSwitch: payload.killSwitch,
    subjectCount: count(payload.subjectCount, 'subjectCount'),
    enabledSubjectCount: count(payload.enabledSubjectCount, 'enabledSubjectCount'),
    updatedBy: payload.updatedBy,
    targetExists: payload.targetExists,
    targetEnabled: payload.targetEnabled,
    targetActor: payload.targetActor,
    legacyV1: Object.freeze({
      version: payload.legacyV1.version,
      enabled: payload.legacyV1.enabled,
      killSwitch: payload.legacyV1.killSwitch,
      subjectCount: count(payload.legacyV1.subjectCount, 'legacyV1.subjectCount'),
      enabledSubjectCount: count(
        payload.legacyV1.enabledSubjectCount,
        'legacyV1.enabledSubjectCount',
      ),
      updatedBy: payload.legacyV1.updatedBy,
    }),
  });
  if (
    state.enabledSubjectCount > state.subjectCount ||
    state.legacyV1.enabledSubjectCount > state.legacyV1.subjectCount ||
    (state.targetEnabled && !state.targetExists) ||
    (!state.targetExists && state.targetActor !== null)
  ) {
    fail('database returned a contradictory flag state');
  }
  return state;
}

function readFlagState(config, environment, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = withPsqlChildEnvironment(config.directUrl, environment, (childEnvironment) =>
    spawn(
      'psql',
      ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', `subject_id=${config.userId}`],
      boundedPsqlSpawnOptions(childEnvironment, {
        input: FLAG_STATE_SQL,
        encoding: 'utf8',
      }),
    ),
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(config.directUrl, '[redacted]')
      .trim();
    fail(`database read failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const rows = String(result.stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1) fail('the canonical staging M2-A flag was not found exactly once');
  return decodeM2A3StagingPreviewFlagState(rows[0]);
}

function assertSafeShape(state) {
  if (state.killSwitch) fail('the M2-A kill switch must remain clear');
  if (
    state.legacyV1.enabled ||
    state.legacyV1.killSwitch ||
    state.legacyV1.subjectCount !== 0 ||
    state.legacyV1.enabledSubjectCount !== 0
  ) {
    fail('the legacy V1 staging protocol must remain globally dormant without subjects');
  }
}

function assertNoSubjects(state) {
  if (
    state.subjectCount !== 0 ||
    state.enabledSubjectCount !== 0 ||
    state.targetExists ||
    state.targetEnabled ||
    state.targetActor !== null
  ) {
    fail('M2-A staging preview forbids every residual subject override');
  }
}

export function assertM2A3StagingPreviewFlagOff(state) {
  assertSafeShape(state);
  assertNoSubjects(state);
  if (state.enabled) fail('the M2-A staging preview flag must be OFF');
}

export function assertM2A3StagingPreviewFlagActive(state) {
  assertSafeShape(state);
  assertNoSubjects(state);
  if (!state.enabled || state.updatedBy !== ACTOR) {
    fail('the M2-A staging preview flag is absent or owned by another operator');
  }
}

export function assertM2A3StagingPreviewCanary(state) {
  assertSafeShape(state);
  if (
    state.enabled ||
    state.subjectCount !== 1 ||
    state.enabledSubjectCount !== 1 ||
    !state.targetExists ||
    !state.targetEnabled ||
    state.targetActor !== ACTOR ||
    state.updatedBy !== ACTOR
  ) {
    fail('the M2-A staging canary override is not exact or is owned by another operator');
  }
}

export function assertM2A3StagingPreviewEffectiveSafe(state) {
  if (!state.killSwitch || !state.legacyV1.killSwitch) {
    fail('both M2-A and legacy V1 kill switches must be armed for emergency safety');
  }
}

function nonPiiObservation(state) {
  return Object.freeze({
    m2a: Object.freeze({
      version: state.version,
      enabled: state.enabled,
      killSwitch: state.killSwitch,
      subjectCount: state.subjectCount,
      enabledSubjectCount: state.enabledSubjectCount,
    }),
    legacyV1: Object.freeze({
      version: state.legacyV1.version,
      enabled: state.legacyV1.enabled,
      killSwitch: state.legacyV1.killSwitch,
      subjectCount: state.legacyV1.subjectCount,
      enabledSubjectCount: state.legacyV1.enabledSubjectCount,
    }),
  });
}

function assertTransition(before, after, enabled) {
  assertSafeShape(after);
  assertNoSubjects(after);
  if (
    after.enabled !== enabled ||
    after.version !== before.version + 1 ||
    after.updatedBy !== ACTOR
  ) {
    fail('the audited M2-A global flag transition was not applied exactly');
  }
}

function mutateSubjectAndRecover(config, before, enabled, query, mutate) {
  let mutationError = null;
  try {
    mutate(
      enabled
        ? {
            operation: 'set-subject',
            key: FLAG_KEY,
            environment: FLAG_ENVIRONMENT,
            enabled: 'true',
            subjectType: 'user',
            subjectId: config.userId,
            actor: config.actor,
            reason: `${config.reason}; action=enable-canary`,
            expectedVersion: before.version,
          }
        : {
            operation: 'remove-subject',
            key: FLAG_KEY,
            environment: FLAG_ENVIRONMENT,
            subjectType: 'user',
            subjectId: config.userId,
            actor: config.actor,
            reason: `${config.reason}; action=disable-canary`,
            expectedVersion: before.version,
          },
      { directUrl: config.directUrl },
    );
  } catch (error) {
    mutationError = error;
  }
  const after = query(config);
  try {
    if (after.version !== before.version + 1) {
      fail('the M2-A canary parent flag version did not advance exactly');
    }
    if (enabled) assertM2A3StagingPreviewCanary(after);
    else assertM2A3StagingPreviewFlagOff(after);
  } catch (verificationError) {
    if (mutationError !== null) throw mutationError;
    throw verificationError;
  }
  return {
    state: enabled ? 'canary' : 'off',
    version: after.version,
    changed: true,
    acknowledgement: mutationError === null ? 'received' : 'recovered',
  };
}

function mutateAndRecover(config, before, enabled, query, mutate) {
  let mutationError = null;
  try {
    mutate(
      {
        operation: 'set-global',
        key: FLAG_KEY,
        environment: FLAG_ENVIRONMENT,
        enabled: String(enabled),
        actor: config.actor,
        reason: `${config.reason}; action=${enabled ? 'activate' : 'deactivate'}`,
        expectedVersion: before.version,
      },
      { directUrl: config.directUrl },
    );
  } catch (error) {
    mutationError = error;
  }
  const after = query(config);
  try {
    assertTransition(before, after, enabled);
  } catch (verificationError) {
    if (mutationError !== null) throw mutationError;
    throw verificationError;
  }
  return {
    state: enabled ? 'active' : 'off',
    version: after.version,
    changed: true,
    acknowledgement: mutationError === null ? 'received' : 'recovered',
  };
}

function emergencyKillAndRecover(config, before, query, mutate) {
  const recoverableErrors = [];
  let attempted = 0;
  let current = before;
  for (let attempt = 1; attempt <= EMERGENCY_KILL_MAX_ATTEMPTS; attempt += 1) {
    for (const target of [
      { key: FLAG_KEY, version: current.version, armed: current.killSwitch },
      {
        key: LEGACY_FLAG_KEY,
        version: current.legacyV1.version,
        armed: current.legacyV1.killSwitch,
      },
    ]) {
      if (target.armed) continue;
      attempted += 1;
      try {
        mutate(
          {
            operation: 'set-kill-switch',
            key: target.key,
            environment: FLAG_ENVIRONMENT,
            enabled: 'true',
            actor: config.actor,
            reason: `${config.reason}; action=emergency-kill; flag=${target.key}; attempt=${attempt}`,
            expectedVersion: target.version,
          },
          { directUrl: config.directUrl },
        );
      } catch (error) {
        recoverableErrors.push(error);
      }
    }

    try {
      current = query(config);
    } catch (error) {
      recoverableErrors.push(error);
      // Une lecture peut perdre sa réponse après que les deux mutations ont été
      // commises. La tentative suivante relit/rejoue sous CAS ; seule la lecture
      // durable finale peut acquitter la convergence multi-flag.
      continue;
    }
    try {
      assertM2A3StagingPreviewEffectiveSafe(current);
      return {
        state: 'safe',
        version: current.version,
        legacyV1Version: current.legacyV1.version,
        changed: attempted > 0,
        acknowledgement: recoverableErrors.length === 0 ? 'received' : 'recovered',
      };
    } catch {
      // Une mutation multi-flag n'est pas atomique. Relire puis retenter uniquement le kill
      // encore absent empêche un échec V1 transitoire de laisser le protocole utilisable.
    }
  }
  fail(`emergency kill did not converge after ${EMERGENCY_KILL_MAX_ATTEMPTS} attempts`);
}

export function runM2A3StagingPreviewFlagCommand(
  command,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM2A3StagingPreviewFlagEnvironment(environment, command);
  const parseDatabase = dependencies.parseDatabaseEnvironment ?? parseM1BStagingDatabaseEnvironment;
  const database = parseDatabase(environment);
  if (database.directUrl !== config.directUrl) {
    fail('the staging database certification did not preserve the exact DIRECT_URL snapshot');
  }
  const certifyDatabase = dependencies.certifyDatabase ?? certifyM1BStagingDatabase;
  certifyDatabase(environment, { spawnSync: dependencies.spawnSync ?? spawnSync });
  const query =
    dependencies.readState ?? ((current) => readFlagState(current, environment, dependencies));
  const mutate =
    dependencies.runOperation ??
    ((input, operationDependencies) =>
      runReleaseFlagOperation(input, { ...operationDependencies, environment }));
  const before = query(config);

  if (command === 'emergency-kill') {
    if (before.killSwitch && before.legacyV1.killSwitch) {
      assertM2A3StagingPreviewEffectiveSafe(before);
      return {
        command,
        state: 'safe',
        version: before.version,
        legacyV1Version: before.legacyV1.version,
        changed: false,
      };
    }
    return { command, ...emergencyKillAndRecover(config, before, query, mutate) };
  }
  if (command === 'assert-effective-safe') {
    assertM2A3StagingPreviewEffectiveSafe(before);
    return {
      command,
      state: 'safe',
      version: before.version,
      legacyV1Version: before.legacyV1.version,
      changed: false,
      observed: nonPiiObservation(before),
    };
  }

  if (command === 'preflight') {
    assertM2A3StagingPreviewFlagOff(before);
    return {
      command,
      state: 'off',
      version: before.version,
      changed: false,
      observed: nonPiiObservation(before),
    };
  }
  if (command === 'enable-canary') {
    assertSafeShape(before);
    if (
      !before.enabled &&
      before.targetExists &&
      before.targetEnabled &&
      before.subjectCount === 1 &&
      before.enabledSubjectCount === 1
    ) {
      assertM2A3StagingPreviewCanary(before);
      return { command, state: 'canary', version: before.version, changed: false };
    }
    assertM2A3StagingPreviewFlagOff(before);
    return { command, ...mutateSubjectAndRecover(config, before, true, query, mutate) };
  }
  if (command === 'disable-canary') {
    assertSafeShape(before);
    if (!before.targetExists && before.subjectCount === 0) {
      assertM2A3StagingPreviewFlagOff(before);
      return { command, state: 'off', version: before.version, changed: false };
    }
    assertM2A3StagingPreviewCanary(before);
    return { command, ...mutateSubjectAndRecover(config, before, false, query, mutate) };
  }
  if (command === 'activate') {
    assertSafeShape(before);
    if (before.enabled) {
      assertM2A3StagingPreviewFlagActive(before);
      return { command, state: 'active', version: before.version, changed: false };
    }
    // set-global ne modifie pas les overrides. Prouver le zéro-sujet AVANT le CAS évite qu'un
    // override résiduel/concurrent survive à une activation pourtant commitée.
    assertM2A3StagingPreviewFlagOff(before);
    return { command, ...mutateAndRecover(config, before, true, query, mutate) };
  }
  if (command === 'deactivate') {
    assertSafeShape(before);
    if (!before.enabled) {
      assertM2A3StagingPreviewFlagOff(before);
      return { command, state: 'off', version: before.version, changed: false };
    }
    assertM2A3StagingPreviewFlagActive(before);
    return { command, ...mutateAndRecover(config, before, false, query, mutate) };
  }
  if (command === 'assert-active') {
    assertM2A3StagingPreviewFlagActive(before);
    return {
      command,
      state: 'active',
      version: before.version,
      changed: false,
      observed: nonPiiObservation(before),
    };
  }
  if (command === 'assert-off') {
    assertM2A3StagingPreviewFlagOff(before);
    return {
      command,
      state: 'off',
      version: before.version,
      changed: false,
      observed: nonPiiObservation(before),
    };
  }
  if (command === 'assert-canary') {
    assertM2A3StagingPreviewCanary(before);
    return {
      command,
      state: 'canary',
      version: before.version,
      changed: false,
      observed: nonPiiObservation(before),
    };
  }
  fail(
    'command must be preflight, enable-canary, disable-canary, activate, deactivate, ' +
      'emergency-kill, assert-effective-safe, assert-canary, assert-active or assert-off',
  );
}

function main() {
  const result = runM2A3StagingPreviewFlagCommand(process.argv[2]);
  if (process.env.BOB_M2A3_STAGING_OUTPUT === 'json') {
    if (result.observed === undefined) fail('JSON output is limited to state assertions');
    process.stdout.write(
      `${JSON.stringify({
        schema: 'bob.agent-mission.m2a3.staging-preview-flag-observation',
        version: 1,
        command: result.command,
        state: result.state,
        changed: result.changed,
        observed: result.observed,
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `agent-mission-m2a3-staging-preview-flag:ok:${result.command}:${result.state}` +
      `:v${result.version}:${result.changed ? 'changed' : 'unchanged'}` +
      `${result.legacyV1Version ? `:legacy-v${result.legacyV1Version}` : ''}` +
      `${result.acknowledgement ? `:${result.acknowledgement}` : ''}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'agent-mission-m2a3-staging-preview-flag:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}
