#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertAppliedMigrationChecksums,
  parseAppliedMigrationRows,
  readLocalMigrationChecksums,
} from './assert-applied-migration-checksums.mjs';
import { certifyM1BStagingDatabase } from './agent-mission-m1b-staging-database.mjs';
import {
  boundedPsqlSpawnOptions,
  PSQL_CONNECT_TIMEOUT_SECONDS,
  withPsqlChildEnvironment,
} from './psql-child-environment.mjs';

const POSITIVE_INTEGER = /^[1-9][0-9]{0,9}$/u;
const DATABASE_ROLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const KEY_MANAGER_PROCESS_TIMEOUT_MS = 75_000;
const REQUIRED_MIGRATIONS = Object.freeze([
  '20260726010000_agent_missions_expand',
  '20260726020000_agent_missions_validate',
  '20260727130000_release_flag_cabinet_subject_revocation_fence',
  '20260727140000_agent_mission_realtime_lease_expand',
  '20260727150000_agent_mission_realtime_lease_validate',
  '20260727160000_realtime_admission_cancellation_fence_expand',
  '20260727170000_realtime_admission_cancellation_fence_validate',
  '20260727180000_agent_mission_event_command_namespace_expand',
  '20260727190000_agent_mission_event_command_namespace_validate',
  '20260727200000_agent_mission_event_command_namespace_cutover',
  '20260727210000_agent_mission_fingerprint_key_readiness',
  '20260727220000_agent_mission_bootstrap_receipt_expand',
  '20260727230000_agent_mission_bootstrap_receipt_validate',
]);

const APPLIED_MIGRATIONS_SQL = `
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.format('%s|%s', migration_name, checksum)
  FROM public."_prisma_migrations"
 WHERE finished_at IS NOT NULL
   AND rolled_back_at IS NULL
 ORDER BY migration_name;
`;

const CLOSE_CAPACITY_SQL = `
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE bob_realtime_capacity;
SELECT id FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
UPDATE public.realtime_global_capacity
   SET mode = 'closed',
       revision = revision + 1,
       "updatedAt" = clock_timestamp()
 WHERE id = 1
   AND mode = 'active';
`;

const CAPACITY_STATE_SQL = `
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE bob_realtime_capacity;
SELECT pg_catalog.format('%s|%s', mode, "usedSessions")
  FROM public.realtime_global_capacity
 WHERE id = 1;
`;

const ACTIVE_CAPACITY_CONFIGURATION_SQL = `
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE bob_realtime_capacity;
SELECT pg_catalog.set_config('bob.realtime.capacity_provider', :'provider', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_model', :'model', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_global_max', :'global_max', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_provider_max', :'provider_max', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_config_version', :'config_version', TRUE);
DO $certify_active_realtime_capacity$
DECLARE
  selected_provider TEXT := pg_catalog.current_setting('bob.realtime.capacity_provider');
  selected_model TEXT := pg_catalog.current_setting('bob.realtime.capacity_model');
  selected_global_max INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_global_max')::INTEGER;
  selected_provider_max INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_provider_max')::INTEGER;
  selected_version INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_config_version')::INTEGER;
  state_row public.realtime_global_capacity%ROWTYPE;
BEGIN
  SELECT *
    INTO STRICT state_row
    FROM public.realtime_global_capacity
   WHERE id = 1;
  IF state_row.mode <> 'active'
     OR state_row."providerId" IS DISTINCT FROM selected_provider
     OR state_row."providerModel" IS DISTINCT FROM selected_model
     OR state_row."globalMaxSessions" IS DISTINCT FROM selected_global_max
     OR state_row."providerMaxSessions" IS DISTINCT FROM selected_provider_max
     OR state_row."configVersion" IS DISTINCT FROM selected_version
     OR state_row."retryAfterSeconds" <> 10
     OR state_row."activatedAt" IS NULL
     OR state_row."usedSessions" < 0
     OR state_row."usedSessions" > selected_global_max THEN
    RAISE EXCEPTION 'M1-B staging active capacity configuration drift';
  END IF;
END;
$certify_active_realtime_capacity$;
`;

const CONFIGURE_CAPACITY_SQL = `
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE bob_realtime_capacity;
SELECT id FROM public.realtime_global_capacity WHERE id = 1 FOR UPDATE;
SELECT pg_catalog.set_config('bob.realtime.capacity_provider', :'provider', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_model', :'model', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_global_max', :'global_max', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_provider_max', :'provider_max', TRUE);
SELECT pg_catalog.set_config('bob.realtime.capacity_config_version', :'config_version', TRUE);
DO $configure_realtime_capacity$
DECLARE
  selected_provider TEXT := pg_catalog.current_setting('bob.realtime.capacity_provider');
  selected_model TEXT := pg_catalog.current_setting('bob.realtime.capacity_model');
  selected_global_max INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_global_max')::INTEGER;
  selected_provider_max INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_provider_max')::INTEGER;
  selected_version INTEGER :=
    pg_catalog.current_setting('bob.realtime.capacity_config_version')::INTEGER;
  state_row public.realtime_global_capacity%ROWTYPE;
  same_configuration BOOLEAN;
BEGIN
  IF selected_provider <> 'openai'
     OR length(selected_model) NOT BETWEEN 1 AND 100
     OR selected_global_max NOT BETWEEN 1 AND 1000
     OR selected_provider_max NOT BETWEEN selected_global_max AND 10000
     OR selected_version NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION 'M1-B staging capacity activation input rejected';
  END IF;

  SELECT *
    INTO STRICT state_row
    FROM public.realtime_global_capacity
   WHERE id = 1
   FOR UPDATE;
  same_configuration :=
    state_row."providerId" IS NOT DISTINCT FROM selected_provider
    AND state_row."providerModel" IS NOT DISTINCT FROM selected_model
    AND state_row."globalMaxSessions" IS NOT DISTINCT FROM selected_global_max
    AND state_row."providerMaxSessions" IS NOT DISTINCT FROM selected_provider_max
    AND state_row."configVersion" IS NOT DISTINCT FROM selected_version;

  IF state_row.mode <> 'closed' THEN
    RAISE EXCEPTION 'M1-B staging capacity must remain closed until final activation';
  END IF;
  IF state_row."usedSessions" <> 0 THEN
    RAISE EXCEPTION 'M1-B staging capacity activation requires a complete drain';
  END IF;
  IF state_row."configVersion" IS NOT NULL
     AND NOT same_configuration
     AND selected_version <= state_row."configVersion" THEN
    RAISE EXCEPTION 'M1-B staging capacity configuration cannot roll back';
  END IF;

  UPDATE public.realtime_global_capacity
     SET mode = 'active',
         "providerId" = selected_provider,
         "providerModel" = selected_model,
         "globalMaxSessions" = selected_global_max,
         "providerMaxSessions" = selected_provider_max,
         "configVersion" = selected_version,
         "retryAfterSeconds" = 10,
         "activatedAt" = clock_timestamp(),
         revision = revision + 1,
         "updatedAt" = clock_timestamp()
   WHERE id = 1;
END;
$configure_realtime_capacity$;
`;

const RELEASE_FLAG_SQL = `
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.format(
         '%s|%s|%s|%s|%s',
         v1_flag.version,
         CASE WHEN v1_flag.enabled THEN 'true' ELSE 'false' END,
         CASE WHEN v1_flag."killSwitch" THEN 'true' ELSE 'false' END,
         (
           SELECT pg_catalog.count(*)
             FROM public.release_flag_subjects AS subject
            WHERE subject."flagId" = v1_flag.id
         ),
         m2a_flag.version
       )
  FROM public.release_flags AS v1_flag
  JOIN public.release_flags AS m2a_flag
    ON m2a_flag.environment = v1_flag.environment
   AND m2a_flag.key = 'bob.agent_missions.quote.m2a'
 WHERE v1_flag.key = 'bob.agent_missions.quote.v1'
   AND v1_flag.environment = 'staging'::public."ReleaseEnvironment";
`;

const FOREIGN_AUTHORITY_SNAPSHOT_SQL = `
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SELECT pg_catalog.jsonb_build_object(
  'conversationFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(floor) ORDER BY floor."keySpace"),
      '[]'::jsonb
    )
      FROM public.realtime_mistral_conversation_key_version_floors AS floor
  ),
  'conversationBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(binding)
        ORDER BY binding."keySpace", binding."keyVersion"
      ),
      '[]'::jsonb
    )
      FROM public.realtime_mistral_conversation_key_bindings AS binding
  ),
  'identityFloors', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(floor) ORDER BY floor."keySpace"),
      '[]'::jsonb
    )
      FROM public.realtime_mistral_conversation_identity_key_version_floors AS floor
  ),
  'identityBindings', (
    SELECT coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(binding)
        ORDER BY binding."keySpace", binding."keyVersion"
      ),
      '[]'::jsonb
    )
      FROM public.realtime_mistral_conversation_identity_key_bindings AS binding
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
)::text;
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-release:${message}`);
}

function required(environment, name, maximum = 8_192) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function positiveInteger(environment, name, minimum, maximum) {
  const value = required(environment, name, 10);
  if (!POSITIVE_INTEGER.test(value)) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} is outside its allowed range`);
  }
  return parsed;
}

export function parseM1BStagingReleaseEnvironment(phase, environment = process.env) {
  if (phase !== 'predeploy' && phase !== 'postdeploy' && phase !== 'restore-capacity') {
    fail('phase must be predeploy, postdeploy or restore-capacity');
  }
  if (required(environment, 'CABINET_RELEASE_ENV', 16) !== 'staging') {
    fail('this targeted release gate is staging-only');
  }
  const appRole = required(environment, 'APP_DATABASE_ROLE', 63);
  if (!DATABASE_ROLE.test(appRole)) fail('APP_DATABASE_ROLE is invalid');
  const drainTimeoutSeconds =
    environment.BOB_LIVE_DRAIN_TIMEOUT_SECONDS === undefined
      ? 930
      : positiveInteger(environment, 'BOB_LIVE_DRAIN_TIMEOUT_SECONDS', 30, 1_800);
  return Object.freeze({
    phase,
    environment,
    directUrl: required(environment, 'DIRECT_URL'),
    runtimeUrl: required(environment, 'DATABASE_URL'),
    appRole,
    drainTimeoutSeconds,
  });
}

function securePsql(
  url,
  { input, variables = [], file, label = file ?? 'inline-sql' },
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
    ...(file === undefined ? ['--single-transaction'] : []),
    ...variables.flatMap(([name, value]) => ['-v', `${name}=${value}`]),
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
    const failureKind =
      result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
        ? 'timeout'
        : 'nonzero-exit';
    fail(`PostgreSQL gate ${label} failed (${failureKind})`);
  }
  return String(result.stdout ?? '').trim();
}

async function assertStrictMigrationState(config, dependencies = {}) {
  const output = securePsql(
    config.directUrl,
    { input: APPLIED_MIGRATIONS_SQL, label: 'migration-inventory' },
    config.environment,
    dependencies,
  );
  let applied;
  try {
    applied = parseAppliedMigrationRows(output);
  } catch {
    fail('applied migration inventory is invalid');
  }
  const local = await (dependencies.readLocalMigrationChecksums ?? readLocalMigrationChecksums)();
  let summary;
  try {
    summary = assertAppliedMigrationChecksums({
      applied,
      local,
      allowPendingLocal: false,
    });
  } catch {
    fail('migration checksum or pending-state proof failed');
  }
  const appliedNames = new Set(applied.map(({ name }) => name));
  if (REQUIRED_MIGRATIONS.some((name) => !appliedNames.has(name))) {
    fail('the complete M1-A/M1-B migration train is not applied');
  }
  return summary;
}

function closeCapacity(config, dependencies = {}) {
  securePsql(
    config.directUrl,
    { input: CLOSE_CAPACITY_SQL, label: 'capacity-close' },
    config.environment,
    dependencies,
  );
}

function readCapacityState(config, dependencies = {}) {
  const raw = securePsql(
    config.directUrl,
    { input: CAPACITY_STATE_SQL, label: 'capacity-state' },
    config.environment,
    dependencies,
  );
  const match = /^(active|closed)\|([0-9]{1,10})$/u.exec(raw);
  if (match === null) fail('realtime capacity returned an invalid state');
  const usedSessions = Number(match[2]);
  if (!Number.isSafeInteger(usedSessions)) {
    fail('realtime capacity returned an invalid state');
  }
  return Object.freeze({ mode: match[1], usedSessions });
}

async function waitForClosedCapacity(config, dependencies = {}, initialState) {
  const now = dependencies.now ?? (() => Date.now());
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + config.drainTimeoutSeconds * 1_000;
  let state = initialState;
  while (true) {
    state ??= (dependencies.readCapacityState ?? readCapacityState)(config, dependencies);
    if (state.mode !== 'closed') {
      fail('realtime capacity returned an invalid drain state');
    }
    if (state.usedSessions === 0) return;
    if (now() >= deadline) fail('realtime capacity did not drain before the deadline');
    await sleep(5_000);
    state = undefined;
  }
}

async function closeAndDrainCapacity(config, dependencies = {}) {
  closeCapacity(config, dependencies);
  await waitForClosedCapacity(config, dependencies);
}

function runKeyManager(mode, config, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(
    process.execPath,
    ['apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs', mode],
    {
      encoding: 'utf8',
      env: {
        ...config.environment,
        PGCONNECT_TIMEOUT: PSQL_CONNECT_TIMEOUT_SECONDS,
      },
      timeout: KEY_MANAGER_PROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  if (result.status !== 0) fail(`fingerprint key manager ${mode} failed`);
}

function readReleaseFlag(config, dependencies = {}) {
  const raw = securePsql(
    config.directUrl,
    { input: RELEASE_FLAG_SQL, label: 'release-flag-snapshot' },
    config.environment,
    dependencies,
  );
  const [version, enabled, killSwitch, subjectCount, m2aVersion, ...extra] = raw.split('|');
  if (
    extra.length > 0 ||
    !POSITIVE_INTEGER.test(version ?? '') ||
    enabled !== 'false' ||
    !['true', 'false'].includes(killSwitch) ||
    subjectCount !== '0' ||
    !POSITIVE_INTEGER.test(m2aVersion ?? '')
  ) {
    fail('canonical AgentMission release flag snapshot is invalid');
  }
  return { version, enabled, killSwitch, subjectCount, m2aVersion };
}

function certifyAgentMissionAcl(config, dependencies = {}) {
  securePsql(
    config.runtimeUrl,
    {
      file: 'apps/api/prisma/agent-missions-release-cert.sql',
      label: 'agent-mission-acl',
      variables: [['app_role', config.appRole]],
    },
    config.environment,
    dependencies,
  );
  const flag = readReleaseFlag(config, dependencies);
  securePsql(
    config.runtimeUrl,
    {
      file: 'apps/api/prisma/agent-mission-realtime-release-cert.sql',
      label: 'agent-mission-realtime-acl',
      variables: [
        ['app_role', config.appRole],
        ['release_env', 'staging'],
        ['release_flag_version', flag.version],
        ['release_flag_kill_switch', flag.killSwitch],
        ['m2a_release_flag_version', flag.m2aVersion],
      ],
    },
    config.environment,
    dependencies,
  );
}

function certifyCapacityAuthority(config, dependencies = {}) {
  securePsql(
    config.directUrl,
    {
      file: 'apps/api/prisma/realtime-global-capacity-release-cert.sql',
      label: 'realtime-capacity-authority',
      variables: [['app_role', config.appRole]],
    },
    config.environment,
    dependencies,
  );
}

function foreignAuthoritySnapshot(config, dependencies = {}) {
  const snapshot = securePsql(
    config.directUrl,
    {
      input: FOREIGN_AUTHORITY_SNAPSHOT_SQL,
      label: 'foreign-authority-snapshot',
    },
    config.environment,
    dependencies,
  );
  if (snapshot.length < 2 || snapshot.length > 128 * 1024) {
    fail('foreign authority snapshot is invalid');
  }
  try {
    const parsed = JSON.parse(snapshot);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('foreign authority snapshot is invalid');
    }
  } catch {
    fail('foreign authority snapshot is invalid');
  }
  return snapshot;
}

function isBobLiveEnabled(config) {
  const liveEnabled =
    config.environment.BOB_LIVE_ENABLED ?? config.environment.OPENAI_REALTIME_ENABLED ?? 'false';
  if (liveEnabled !== 'true' && liveEnabled !== 'false') {
    fail('Bob Live enablement is invalid');
  }
  return liveEnabled === 'true';
}

function capacityConfiguration(config) {
  if (!isBobLiveEnabled(config)) {
    return Object.freeze({ enabled: false });
  }
  const provider = config.environment.BOB_LIVE_PROVIDER ?? 'openai';
  if (provider !== 'openai') fail('M1-B staging requires the OpenAI Bob Live provider');
  const model = config.environment.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
  if (!SAFE_MODEL.test(model)) fail('OPENAI_REALTIME_MODEL is invalid');
  const globalMax = positiveInteger(
    config.environment,
    'BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS',
    1,
    1_000,
  );
  const providerMax = positiveInteger(
    config.environment,
    'BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS',
    globalMax,
    10_000,
  );
  const configVersion = positiveInteger(
    config.environment,
    'BOB_LIVE_CAPACITY_CONFIG_VERSION',
    1,
    2_147_483_647,
  );
  return Object.freeze({
    enabled: true,
    provider,
    model,
    globalMax,
    providerMax,
    configVersion,
  });
}

function capacityVariables(configuration) {
  return [
    ['provider', configuration.provider],
    ['model', configuration.model],
    ['global_max', String(configuration.globalMax)],
    ['provider_max', String(configuration.providerMax)],
    ['config_version', String(configuration.configVersion)],
  ];
}

function configureCapacity(config, dependencies = {}, configuration) {
  const selected = configuration ?? capacityConfiguration(config);
  if (!selected.enabled) return 'closed';
  securePsql(
    config.directUrl,
    {
      input: CONFIGURE_CAPACITY_SQL,
      label: 'capacity-configure',
      variables: capacityVariables(selected),
    },
    config.environment,
    dependencies,
  );
  return 'active';
}

function certifyActiveCapacity(config, configuration, dependencies = {}) {
  securePsql(
    config.directUrl,
    {
      input: ACTIVE_CAPACITY_CONFIGURATION_SQL,
      label: 'capacity-active-configuration',
      variables: capacityVariables(configuration),
    },
    config.environment,
    dependencies,
  );
}

async function restoreCapacity(config, dependencies = {}) {
  const configuration = capacityConfiguration(config);
  const state = (dependencies.readCapacityState ?? readCapacityState)(config, dependencies);

  if (state.mode === 'active') {
    if (configuration.enabled) {
      (dependencies.certifyActiveCapacity ?? certifyActiveCapacity)(
        config,
        configuration,
        dependencies,
      );
      return 'active';
    }
    await (dependencies.closeAndDrainCapacity ?? closeAndDrainCapacity)(config, dependencies);
    (dependencies.certifyCapacityAuthority ?? certifyCapacityAuthority)(config, dependencies);
    return 'closed';
  }

  await (dependencies.waitForClosedCapacity ?? waitForClosedCapacity)(config, dependencies, state);
  (dependencies.certifyCapacityAuthority ?? certifyCapacityAuthority)(config, dependencies);
  if (!configuration.enabled) return 'closed';
  return (dependencies.configureCapacity ?? configureCapacity)(config, dependencies, configuration);
}

export async function runM1BStagingRelease(phase, environment = process.env, dependencies = {}) {
  const config = parseM1BStagingReleaseEnvironment(phase, environment);
  const certifyDatabase = dependencies.certifyDatabase ?? certifyM1BStagingDatabase;
  certifyDatabase(environment);
  const migrations = await (dependencies.assertStrictMigrationState ?? assertStrictMigrationState)(
    config,
    dependencies,
  );
  if (phase === 'restore-capacity') {
    const capacity = await (dependencies.restoreCapacity ?? restoreCapacity)(config, dependencies);
    return Object.freeze({
      phase,
      passed: true,
      capacity,
      appliedMigrations: migrations.appliedCount,
      pendingMigrations: migrations.pendingCount,
    });
  }
  const snapshot = (dependencies.foreignAuthoritySnapshot ?? foreignAuthoritySnapshot)(
    config,
    dependencies,
  );

  await (dependencies.closeAndDrainCapacity ?? closeAndDrainCapacity)(config, dependencies);
  (dependencies.certifyCapacityAuthority ?? certifyCapacityAuthority)(config, dependencies);
  (dependencies.runKeyManager ?? runKeyManager)('stage', config, dependencies);
  (dependencies.certifyAgentMissionAcl ?? certifyAgentMissionAcl)(config, dependencies);
  if (phase === 'postdeploy') {
    (dependencies.runKeyManager ?? runKeyManager)('retire', config, dependencies);
  }

  const finalSnapshot = (dependencies.foreignAuthoritySnapshot ?? foreignAuthoritySnapshot)(
    config,
    dependencies,
  );
  if (finalSnapshot !== snapshot) {
    fail('a foreign protocol authority changed during the M1-B gate');
  }

  const capacity =
    phase === 'postdeploy'
      ? (dependencies.configureCapacity ?? configureCapacity)(config, dependencies)
      : 'closed';
  return Object.freeze({
    phase,
    passed: true,
    capacity,
    appliedMigrations: migrations.appliedCount,
    pendingMigrations: migrations.pendingCount,
  });
}

async function main() {
  const result = await runM1BStagingRelease(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'agent-mission-m1b-staging-release:failed'}\n`,
    );
    process.exitCode = 1;
  });
}
