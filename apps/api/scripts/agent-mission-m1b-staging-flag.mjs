#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runReleaseFlagOperation } from './release-flag-ops.mjs';

const FLAG_KEY = 'bob.agent_missions.quote.v1';
const FLAG_ENVIRONMENT = 'staging';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/u;
const ACTOR_PREFIX = 'system:github:agent-mission-m1b-staging:';
const FLAG_MIGRATION = '20260726030000_release_flag_cabinet_subject_revocation_fence';

const FLAG_STATE_SQL = `
SELECT jsonb_build_object(
  'version', flag.version,
  'enabled', flag.enabled,
  'killSwitch', flag."killSwitch",
  'subjectCount', count(subject.id),
  'enabledSubjectCount', count(subject.id) FILTER (WHERE subject.enabled),
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
)
  FROM public.release_flags AS flag
  LEFT JOIN public.release_flag_subjects AS subject
    ON subject."flagId" = flag.id
 WHERE flag.key = '${FLAG_KEY}'
   AND flag.environment = '${FLAG_ENVIRONMENT}'::public."ReleaseEnvironment"
 GROUP BY flag.id, flag.version, flag.enabled, flag."killSwitch";
`;

export const M1B_STAGING_FLAG_BOOTSTRAP_STATE_SQL = `
SELECT pg_catalog.json_build_object(
  'migrationApplied',
  EXISTS (
    SELECT 1
      FROM public."_prisma_migrations" AS migration
     WHERE migration.migration_name = '${FLAG_MIGRATION}'
       AND migration.finished_at IS NOT NULL
       AND migration.rolled_back_at IS NULL
  ),
  'flagCount',
  (
    SELECT count(*)::integer
      FROM public.release_flags AS flag
     WHERE flag.key = '${FLAG_KEY}'
       AND flag.environment = '${FLAG_ENVIRONMENT}'::public."ReleaseEnvironment"
  )
)::text;
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-flag:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 500 } = {}) {
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

function parseDate(value) {
  if (!ISO_DATE.test(value)) {
    fail('BOB_M1B_STAGING_FOUNDER_AUTH_DATE must use YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('BOB_M1B_STAGING_FOUNDER_AUTH_DATE is not a calendar date');
  }
  return value;
}

export function parseM1BStagingFlagEnvironment(environment = process.env) {
  const userId = required(environment, 'BOB_M1B_STAGING_USER_ID', { maximum: 80 });
  if (!UUID.test(userId)) fail('BOB_M1B_STAGING_USER_ID must be a UUID');
  const runId = required(environment, 'BOB_M1B_STAGING_RUN_ID', { maximum: 31 });
  if (!RUN_ID.test(runId)) {
    fail('BOB_M1B_STAGING_RUN_ID must be github.run_id:github.run_attempt');
  }
  const actor = `${ACTOR_PREFIX}${runId}`;
  const founderDate = parseDate(
    required(environment, 'BOB_M1B_STAGING_FOUNDER_AUTH_DATE', { maximum: 10 }),
  );
  const founderChannel = required(environment, 'BOB_M1B_STAGING_FOUNDER_AUTH_CHANNEL', {
    minimum: 2,
    maximum: 40,
  });
  const founderReference = required(environment, 'BOB_M1B_STAGING_FOUNDER_AUTH_REF', {
    minimum: 3,
    maximum: 120,
  });
  const claudeReference = required(environment, 'BOB_M1B_STAGING_CLAUDE_COUNTERSIGN_REF', {
    minimum: 3,
    maximum: 120,
  });
  const gptReference = required(environment, 'BOB_M1B_STAGING_GPT_COUNTERSIGN_REF', {
    minimum: 3,
    maximum: 120,
  });
  const reason = [
    `M1-B staging autorisé ${founderDate}`,
    `canal=${founderChannel}`,
    `référence=${founderReference}`,
    `Claude=${claudeReference}`,
    `GPT=${gptReference}`,
    `run=${runId}`,
  ].join('; ');
  if (reason.length > 500) fail('the composed release-flag audit reason is too long');
  return Object.freeze({
    directUrl: validateDirectUrl(required(environment, 'DIRECT_URL', { maximum: 8_192 })),
    userId,
    actor,
    reason,
  });
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  return value;
}

export function decodeM1BStagingFlagState(value) {
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
    typeof payload.targetExists !== 'boolean' ||
    typeof payload.targetEnabled !== 'boolean' ||
    (payload.targetActor !== null && typeof payload.targetActor !== 'string')
  ) {
    fail('database returned an invalid flag state');
  }
  const state = Object.freeze({
    version: payload.version,
    enabled: payload.enabled,
    killSwitch: payload.killSwitch,
    subjectCount: nonNegativeInteger(payload.subjectCount, 'subjectCount'),
    enabledSubjectCount: nonNegativeInteger(payload.enabledSubjectCount, 'enabledSubjectCount'),
    targetExists: payload.targetExists,
    targetEnabled: payload.targetEnabled,
    targetActor: payload.targetActor,
  });
  if (
    state.enabledSubjectCount > state.subjectCount ||
    (state.targetEnabled && !state.targetExists) ||
    (!state.targetExists && state.targetActor !== null)
  ) {
    fail('database returned a contradictory flag state');
  }
  return state;
}

export function decodeM1BStagingFlagBootstrapState(value) {
  let payload;
  try {
    payload = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('database returned invalid bootstrap state JSON');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    typeof payload.migrationApplied !== 'boolean' ||
    !Number.isSafeInteger(payload.flagCount) ||
    payload.flagCount < 0 ||
    payload.flagCount > 1
  ) {
    fail('database returned an invalid bootstrap state');
  }
  return Object.freeze({
    migrationApplied: payload.migrationApplied,
    flagCount: payload.flagCount,
  });
}

function readFlagState(config, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(
    'psql',
    [
      '--no-psqlrc',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `subject_id=${config.userId}`,
      config.directUrl,
    ],
    {
      input: FLAG_STATE_SQL,
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(config.directUrl, '[redacted]')
      .trim();
    fail(`database read failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const rows = String(result.stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1) fail('the canonical staging release flag was not found exactly once');
  return decodeM1BStagingFlagState(rows[0]);
}

function readBootstrapState(config, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(
    'psql',
    ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', config.directUrl],
    {
      input: M1B_STAGING_FLAG_BOOTSTRAP_STATE_SQL,
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(config.directUrl, '[redacted]')
      .trim();
    fail(`database bootstrap read failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const rows = String(result.stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1) fail('database bootstrap proof returned an ambiguous result');
  return decodeM1BStagingFlagBootstrapState(rows[0]);
}

function assertGlobalOff(state) {
  if (state.enabled) fail('the global AgentMission flag must remain OFF');
}

export function assertM1BStagingFlagPreflight(state) {
  assertGlobalOff(state);
  if (state.killSwitch) fail('the AgentMission kill switch must be clear before certification');
  if (state.enabledSubjectCount !== 0) {
    fail('another AgentMission subject override is already enabled');
  }
  if (state.targetExists) {
    fail('the dedicated staging user override must be absent before certification');
  }
}

export function assertM1BStagingFlagBootstrapPreflight(bootstrap, flagState = null) {
  if (!bootstrap.migrationApplied) {
    if (bootstrap.flagCount !== 0 || flagState !== null) {
      fail('the canonical flag exists before its migration');
    }
    return Object.freeze({ state: 'absent', version: 0 });
  }
  if (bootstrap.flagCount !== 1 || flagState === null) {
    fail('the canonical flag is absent after its migration');
  }
  assertM1BStagingFlagPreflight(flagState);
  return Object.freeze({ state: 'off', version: flagState.version });
}

export function assertM1BStagingFlagActive(before, after, actor) {
  assertGlobalOff(after);
  if (after.killSwitch) fail('the AgentMission kill switch changed during certification');
  if (
    after.version !== before.version + 1 ||
    !after.targetExists ||
    !after.targetEnabled ||
    after.targetActor !== actor ||
    after.enabledSubjectCount !== 1
  ) {
    fail('the dedicated run-owned staging override was not activated exactly');
  }
}

export function assertM1BStagingFlagOff(state) {
  assertGlobalOff(state);
  if (state.killSwitch) fail('the AgentMission kill switch is not in its baseline state');
  if (
    state.targetExists ||
    state.targetEnabled ||
    state.targetActor !== null ||
    state.enabledSubjectCount !== 0
  ) {
    fail('an AgentMission subject override remains active or attached');
  }
}

function assertM1BStagingFlagOwned(state, actor) {
  assertGlobalOff(state);
  if (
    state.killSwitch ||
    !state.targetExists ||
    !state.targetEnabled ||
    state.targetActor !== actor ||
    state.enabledSubjectCount !== 1
  ) {
    fail('the staging override is absent, ambiguous or owned by another run');
  }
}

function removeOwnedOverride(config, before, query, mutate) {
  assertGlobalOff(before);
  if (before.targetExists) {
    assertM1BStagingFlagOwned(before, config.actor);
    mutate(
      {
        operation: 'remove-subject',
        key: FLAG_KEY,
        environment: FLAG_ENVIRONMENT,
        subjectType: 'user',
        subjectId: config.userId,
        actor: config.actor,
        reason: `${config.reason}; rollback`,
        expectedVersion: before.version,
      },
      { directUrl: config.directUrl },
    );
  }
  const after = query(config);
  assertM1BStagingFlagOff(after);
  if (before.targetExists && after.version !== before.version + 1) {
    fail('the parent flag version did not advance during override cleanup');
  }
  return {
    state: 'off',
    version: after.version,
    changed: before.targetExists,
  };
}

export function runM1BStagingFlagCommand(command, environment = process.env, dependencies = {}) {
  const config = parseM1BStagingFlagEnvironment(environment);
  const query = dependencies.readState ?? ((current) => readFlagState(current, dependencies));
  const queryBootstrap =
    dependencies.readBootstrapState ?? ((current) => readBootstrapState(current, dependencies));
  const mutate = dependencies.runOperation ?? runReleaseFlagOperation;

  if (command === 'bootstrap-preflight') {
    const bootstrap = queryBootstrap(config);
    const result = assertM1BStagingFlagBootstrapPreflight(
      bootstrap,
      bootstrap.migrationApplied ? query(config) : null,
    );
    return {
      command,
      state: result.state,
      version: result.version,
      changed: false,
    };
  }
  if (command === 'cleanup') {
    const bootstrap = queryBootstrap(config);
    if (!bootstrap.migrationApplied) {
      const result = assertM1BStagingFlagBootstrapPreflight(bootstrap);
      return {
        command,
        state: result.state,
        version: result.version,
        changed: false,
      };
    }
    if (bootstrap.flagCount !== 1) {
      fail('the canonical flag is absent after its migration');
    }
    return {
      command,
      ...removeOwnedOverride(config, query(config), query, mutate),
    };
  }
  const before = query(config);
  if (command === 'preflight') {
    assertM1BStagingFlagPreflight(before);
    return { command, state: 'off', version: before.version };
  }
  if (command === 'enable') {
    assertM1BStagingFlagPreflight(before);
    mutate(
      {
        operation: 'set-subject',
        key: FLAG_KEY,
        environment: FLAG_ENVIRONMENT,
        enabled: 'true',
        subjectType: 'user',
        subjectId: config.userId,
        actor: config.actor,
        reason: config.reason,
        expectedVersion: before.version,
      },
      { directUrl: config.directUrl },
    );
    const after = query(config);
    assertM1BStagingFlagActive(before, after, config.actor);
    return { command, state: 'active', version: after.version, changed: true };
  }
  if (command === 'disable') {
    return {
      command,
      ...removeOwnedOverride(config, before, query, mutate),
    };
  }
  if (command === 'assert-active') {
    assertM1BStagingFlagOwned(before, config.actor);
    return { command, state: 'active', version: before.version };
  }
  if (command === 'assert-off') {
    assertM1BStagingFlagOff(before);
    return { command, state: 'off', version: before.version };
  }
  fail(
    'command must be bootstrap-preflight, cleanup, preflight, enable, disable, assert-active or assert-off',
  );
}

function main() {
  const [command] = process.argv.slice(2);
  const result = runM1BStagingFlagCommand(command);
  process.stdout.write(
    `agent-mission-m1b-staging-flag:ok:${result.command}:${result.state}:v${result.version}` +
      `${result.changed === true ? ':changed' : result.changed === false ? ':unchanged' : ''}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'agent-mission-m1b-staging-flag:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}
