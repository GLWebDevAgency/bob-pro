#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseAgentMissionFingerprintKeyOperation } from
  './manage-agent-mission-fingerprint-key-versions.mjs';

const VERSION = /^[1-9][0-9]{0,9}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const KEY_STATE_SQL = `
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
SET LOCAL ROLE bob_agent_mission_fingerprint_readiness;
SELECT coalesce(
  jsonb_agg(
    jsonb_build_object(
      'keyVersion', state."keyVersion",
      'keyFingerprint', state."keyFingerprint",
      'retained', state.retained,
      'minimumWriterVersion', state."minimumWriterVersion",
      'highestWriterVersion', state."highestWriterVersion",
      'writerEnabled', state."writerEnabled"
    )
    ORDER BY state."keyVersion"
  ),
  '[]'::jsonb
)
  FROM public.agent_mission_fingerprint_key_readiness(
    string_to_array(:'versions_csv', ',')::integer[]
  ) AS state;
RESET ROLE;
ROLLBACK;
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-key-state:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 16_384 } = {}) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function privilegedPostgresUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('DIRECT_URL must be a valid PostgreSQL URL');
  }
  const username = decodeURIComponent(parsed.username);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || (username !== 'postgres' && !username.startsWith('postgres.'))
  ) {
    fail('DIRECT_URL must use the privileged migration role');
  }
  return value;
}

export function parseM1BStagingKeyStateEnvironment(environment = process.env) {
  const keyVersion = required(environment, 'BOB_M1B_STAGING_HMAC_KEY_VERSION', {
    maximum: 10,
  });
  const keyring = required(environment, 'BOB_M1B_STAGING_HMAC_KEYRING', {
    minimum: 2,
    maximum: 16_384,
  });
  if (
    !VERSION.test(keyVersion)
    || !Number.isSafeInteger(Number(keyVersion))
    || Number(keyVersion) > 2_147_483_647
  ) {
    fail('BOB_M1B_STAGING_HMAC_KEY_VERSION must be a positive PostgreSQL integer');
  }
  const directUrl = privilegedPostgresUrl(
    required(environment, 'DIRECT_URL', { maximum: 8_192 }),
  );
  const operation = parseAgentMissionFingerprintKeyOperation('stage', {
    ...environment,
    DIRECT_URL: directUrl,
    BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: keyVersion,
    BOB_AGENT_MISSION_HMAC_KEYRING: keyring,
  });
  if (!operation.enabled || operation.currentVersion !== Number(keyVersion)) {
    fail('the stable staging keyring could not be resolved exactly');
  }
  if (
    operation.bindings.length > 2
    || operation.bindings.some(({ version }) =>
      version !== operation.currentVersion
      && version !== operation.currentVersion - 1)
  ) {
    fail('the staging keyring must contain only the current version and optional predecessor');
  }
  return Object.freeze({
    directUrl,
    currentVersion: operation.currentVersion,
    bindings: operation.bindings,
  });
}

function exactObject(value, keys) {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function decodeM1BStagingKeyRows(value) {
  let rows;
  try {
    rows = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('database returned invalid key-state JSON');
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 33) {
    fail('database returned an invalid key-state row set');
  }
  const decoded = rows.map((row) => {
    const keys = [
      'keyVersion',
      'keyFingerprint',
      'retained',
      'minimumWriterVersion',
      'highestWriterVersion',
      'writerEnabled',
    ];
    if (
      !exactObject(row, keys)
      || !Number.isSafeInteger(row.keyVersion)
      || row.keyVersion < 1
      || (
        row.keyFingerprint !== null
        && (
          typeof row.keyFingerprint !== 'string'
          || !FINGERPRINT.test(row.keyFingerprint)
        )
      )
      || typeof row.retained !== 'boolean'
      || !(
        (
          row.minimumWriterVersion === null
          && row.highestWriterVersion === null
          && row.writerEnabled === null
        )
        || (
          Number.isSafeInteger(row.minimumWriterVersion)
          && Number.isSafeInteger(row.highestWriterVersion)
          && typeof row.writerEnabled === 'boolean'
          && row.minimumWriterVersion >= 1
          && row.highestWriterVersion >= row.minimumWriterVersion
        )
      )
    ) {
      fail('database returned a non-canonical key-state row');
    }
    return Object.freeze({ ...row });
  });
  if (new Set(decoded.map(({ keyVersion }) => keyVersion)).size !== decoded.length) {
    fail('database returned duplicate key-state rows');
  }
  return Object.freeze(decoded);
}

function assertBindings(rows, config) {
  const configured = new Map(
    config.bindings.map(({ version, fingerprint }) => [version, fingerprint]),
  );
  for (const binding of config.bindings) {
    const row = rows.find(({ keyVersion }) => keyVersion === binding.version);
    if (row?.keyFingerprint !== binding.fingerprint) {
      fail(`stable staging binding ${binding.version} does not match`);
    }
  }
  for (const row of rows) {
    if (row.retained && !configured.has(row.keyVersion)) {
      fail('the stable staging keyring does not cover every retained event version');
    }
  }
}

function uniqueFloor(rows) {
  const serialized = new Set(rows.map((row) => JSON.stringify([
    row.minimumWriterVersion,
    row.highestWriterVersion,
    row.writerEnabled,
  ])));
  if (serialized.size !== 1) fail('database returned inconsistent writer floors');
  const row = rows[0];
  return row.minimumWriterVersion === null
    ? null
    : {
        minimumWriterVersion: row.minimumWriterVersion,
        highestWriterVersion: row.highestWriterVersion,
        writerEnabled: row.writerEnabled,
      };
}

export function assertM1BStagingKeyState(mode, rows, config) {
  if (mode !== 'preflight' && mode !== 'active' && mode !== 'off') {
    fail('mode must be preflight, active or off');
  }
  const current = rows.find(({ keyVersion }) =>
    keyVersion === config.currentVersion);
  if (!current) fail('current stable staging key version is absent from readiness');
  const floor = uniqueFloor(rows);
  if (floor === null) {
    if (
      mode !== 'preflight'
      || config.currentVersion !== 1
      || config.bindings.length !== 1
      || rows.length !== 1
      || current.keyFingerprint !== null
      || current.retained
    ) {
      fail('only a pristine version 1 keyspace may start without a writer floor');
    }
    return Object.freeze({
      mode,
      passed: true,
      keyVersion: 1,
      writerEnabled: null,
      pristine: true,
    });
  }
  if (
    floor.minimumWriterVersion !== config.currentVersion
    || floor.highestWriterVersion !== config.currentVersion
  ) {
    fail('temporary staging certification refuses every key rotation or adjacent floor');
  }
  assertBindings(rows, config);
  const expectedWriter = mode === 'active';
  if (floor.writerEnabled !== expectedWriter) {
    fail(`writer fence is not ${expectedWriter ? 'active' : 'disabled'} exactly`);
  }
  return Object.freeze({
    mode,
    passed: true,
    keyVersion: config.currentVersion,
    writerEnabled: expectedWriter,
    pristine: false,
  });
}

function readKeyRows(config, dependencies = {}) {
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
      `versions_csv=${config.bindings.map(({ version }) => version).join(',')}`,
      config.directUrl,
    ],
    {
      input: KEY_STATE_SQL,
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(config.directUrl, '[redacted]')
      .trim();
    fail(`database proof failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const output = String(result.stdout).trim().split('\n').filter(Boolean);
  if (output.length !== 1) fail('database proof returned an ambiguous result');
  return decodeM1BStagingKeyRows(output[0]);
}

export function certifyM1BStagingKeyState(
  mode,
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingKeyStateEnvironment(environment);
  return assertM1BStagingKeyState(
    mode,
    readKeyRows(config, dependencies),
    config,
  );
}

function main() {
  const result = certifyM1BStagingKeyState(process.argv[2]);
  process.stdout.write(
    `agent-mission-m1b-staging-key-state:ok:${result.mode}:v${result.keyVersion}:`
      + `${result.writerEnabled === null ? 'pristine' : `writer-${result.writerEnabled}`}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error
        ? error.message
        : 'agent-mission-m1b-staging-key-state:unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}

export const M1B_STAGING_KEY_STATE_SQL = KEY_STATE_SQL;
