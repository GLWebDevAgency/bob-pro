#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMANDS = new Set([
  'preflight',
  'enable-canary',
  'assert-canary',
  'disable-canary',
  'activate',
  'assert-active',
  'deactivate',
  'assert-off',
  'emergency-kill',
  'assert-effective-safe',
]);
const FORWARDED_CONTEXT = Object.freeze([
  'SUPABASE_URL',
  'BOB_M1B_STAGING_SUPABASE_PROJECT_REF',
  'BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER',
  'BOB_M1B_STAGING_DATABASE_OID',
  'BOB_M1B_STAGING_DATABASE_NAME',
  'BOB_M2A3_STAGING_RUN_ID',
  'BOB_M2A3_STAGING_RUN_ATTEMPT',
  'BOB_M2A3_STAGING_INITIATOR',
  'BOB_M2A3_STAGING_REPOSITORY',
  'BOB_M2A3_STAGING_RELEASE_SHA',
]);
const CANARY_CONTEXT = Object.freeze(['BOB_M2A3_STAGING_USER_ID']);
const ACTIVATION_AUTHORIZATION_CONTEXT = Object.freeze([
  'BOB_M2A3_STAGING_FOUNDER_AUTH_DATE',
  'BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL',
  'BOB_M2A3_STAGING_FOUNDER_AUTH_REF',
  'BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF',
  'BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF',
]);
const COMMAND_TIMEOUT_MS = Object.freeze({
  'emergency-kill': 660_000,
  'enable-canary': 300_000,
  'disable-canary': 300_000,
  activate: 300_000,
  deactivate: 300_000,
});

function fail(message) {
  throw new Error(`agent-mission-m2a3-staging-preview-flag-railway:${message}`);
}

function required(environment, name, maximum = 16_384) {
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

export function buildM2A3StagingPreviewFlagRailwayInvocation(command, environment = process.env) {
  if (!COMMANDS.has(command)) fail('command is unsupported');
  const projectId = required(environment, 'RAILWAY_PROJECT_ID', 80);
  const environmentId = required(environment, 'RAILWAY_ENVIRONMENT_ID', 80);
  const serviceId = required(environment, 'RAILWAY_API_SERVICE_ID', 80);
  for (const [name, value] of [
    ['RAILWAY_PROJECT_ID', projectId],
    ['RAILWAY_ENVIRONMENT_ID', environmentId],
    ['RAILWAY_API_SERVICE_ID', serviceId],
  ]) {
    if (!UUID.test(value)) fail(`${name} must be a UUID`);
  }

  const assignments = FORWARDED_CONTEXT.map((name) => `${name}=${required(environment, name)}`);
  const needsCanaryIdentity = ['enable-canary', 'disable-canary', 'assert-canary'].includes(
    command,
  );
  for (const name of CANARY_CONTEXT) {
    assignments.push(`${name}=${needsCanaryIdentity ? required(environment, name) : ''}`);
  }
  const needsActivationAuthorization = command === 'enable-canary' || command === 'activate';
  for (const name of ACTIVATION_AUTHORIZATION_CONTEXT) {
    assignments.push(`${name}=${needsActivationAuthorization ? required(environment, name) : ''}`);
  }
  const output = environment.BOB_M2A3_STAGING_OUTPUT ?? '';
  if (output !== '' && output !== 'json') {
    fail('BOB_M2A3_STAGING_OUTPUT must be empty or json');
  }
  assignments.push(`BOB_M2A3_STAGING_OUTPUT=${output}`);

  return Object.freeze({
    executable: 'railway',
    args: Object.freeze([
      'run',
      '--project',
      projectId,
      '--service',
      serviceId,
      '--environment',
      environmentId,
      '--no-local',
      '--',
      'env',
      ...assignments,
      process.execPath,
      'apps/api/scripts/agent-mission-m2a3-staging-preview-flag.mjs',
      command,
    ]),
  });
}

export function runM2A3StagingPreviewFlagRailway(
  command,
  environment = process.env,
  dependencies = {},
) {
  const invocation = buildM2A3StagingPreviewFlagRailwayInvocation(command, environment);
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(invocation.executable, invocation.args, {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    // Le processus enfant certifie la base puis borne chaque appel psql à 45 s.
    // Une mutation ordinaire peut enchaîner certification, lecture, CAS et
    // relecture ; l'arrêt d'urgence converge deux flags sur trois tentatives.
    timeout: COMMAND_TIMEOUT_MS[command] ?? 150_000,
    killSignal: 'SIGKILL',
  });
  if (result.error !== undefined || result.status !== 0) {
    const cause =
      result.error?.code === 'ETIMEDOUT' ? 'timeout' : `exit-${result.status ?? 'signal'}`;
    fail(`Railway flag command failed (${cause})`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    runM2A3StagingPreviewFlagRailway(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
