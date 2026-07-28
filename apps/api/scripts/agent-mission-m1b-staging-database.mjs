#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  boundedPsqlSpawnOptions,
  withPsqlChildEnvironment,
} from './psql-child-environment.mjs';

const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,29}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,9}$/u;
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;

const IDENTITY_SQL = `
SELECT pg_catalog.json_build_object(
  'systemIdentifier', control.system_identifier::text,
  'databaseOid', database.oid::bigint,
  'databaseName', pg_catalog.current_database(),
  'serverEncoding', pg_catalog.current_setting('server_encoding'),
  'inRecovery', pg_catalog.pg_is_in_recovery(),
  'transactionReadOnly',
    pg_catalog.current_setting('transaction_read_only') = 'on',
  'sessionUser', SESSION_USER,
  'currentUser', CURRENT_USER,
  'roleSuperuser', role.rolsuper,
  'roleBypassRls', role.rolbypassrls
)::text
  FROM pg_catalog.pg_control_system() AS control
  JOIN pg_catalog.pg_database AS database
    ON database.datname = pg_catalog.current_database()
  JOIN pg_catalog.pg_roles AS role
    ON role.rolname = CURRENT_USER;
`;

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-database:${message}`);
}

function required(environment, name, { minimum = 1, maximum = 8_192 } = {}) {
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

function postgresUrl(environment, name) {
  const raw = required(environment, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} must be a valid PostgreSQL URL`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.username.length === 0 ||
    parsed.hash.length > 0
  ) {
    fail(`${name} must be a bounded PostgreSQL connection URL`);
  }
  return Object.freeze({ raw, parsed });
}

function decodedUsername(parsed, name) {
  try {
    return decodeURIComponent(parsed.username);
  } catch {
    fail(`${name} contains an invalid username`);
  }
}

function targetsProject(connection, projectRef, name) {
  const username = decodedUsername(connection.parsed, name);
  const hostname = connection.parsed.hostname.toLowerCase();
  if (hostname !== `db.${projectRef}.supabase.co` && !username.endsWith(`.${projectRef}`)) {
    fail(`${name} does not target the pinned Supabase project`);
  }
  return username;
}

export function parseM1BStagingDatabaseEnvironment(environment = process.env) {
  const projectRef = required(environment, 'BOB_M1B_STAGING_SUPABASE_PROJECT_REF', { maximum: 20 });
  if (!PROJECT_REF.test(projectRef)) {
    fail('BOB_M1B_STAGING_SUPABASE_PROJECT_REF must be the exact project ref');
  }
  const expectedSystemIdentifier = required(
    environment,
    'BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER',
    { maximum: 30 },
  );
  if (!SYSTEM_IDENTIFIER.test(expectedSystemIdentifier)) {
    fail('BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER must be canonical');
  }
  const expectedDatabaseOidRaw = required(environment, 'BOB_M1B_STAGING_DATABASE_OID', {
    maximum: 10,
  });
  if (!POSITIVE_INTEGER.test(expectedDatabaseOidRaw)) {
    fail('BOB_M1B_STAGING_DATABASE_OID must be canonical');
  }
  const expectedDatabaseOid = Number(expectedDatabaseOidRaw);
  if (!Number.isSafeInteger(expectedDatabaseOid) || expectedDatabaseOid > 4_294_967_295) {
    fail('BOB_M1B_STAGING_DATABASE_OID is outside PostgreSQL bounds');
  }
  const expectedDatabaseName = required(environment, 'BOB_M1B_STAGING_DATABASE_NAME', {
    maximum: 63,
  });
  if (!DATABASE_NAME.test(expectedDatabaseName)) {
    fail('BOB_M1B_STAGING_DATABASE_NAME must be canonical');
  }
  const appRole = required(environment, 'APP_DATABASE_ROLE', { maximum: 63 });
  if (!DATABASE_NAME.test(appRole)) fail('APP_DATABASE_ROLE must be canonical');

  const supabaseUrl = required(environment, 'SUPABASE_URL');
  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    fail('SUPABASE_URL must be a valid URL');
  }
  if (
    parsedSupabaseUrl.protocol !== 'https:' ||
    parsedSupabaseUrl.origin !== supabaseUrl ||
    parsedSupabaseUrl.hostname !== `${projectRef}.supabase.co`
  ) {
    fail('SUPABASE_URL does not match the pinned staging project');
  }

  const direct = postgresUrl(environment, 'DIRECT_URL');
  const runtime = postgresUrl(environment, 'DATABASE_URL');
  const directUsername = targetsProject(direct, projectRef, 'DIRECT_URL');
  const runtimeUsername = targetsProject(runtime, projectRef, 'DATABASE_URL');
  if (directUsername !== 'postgres' && directUsername !== `postgres.${projectRef}`) {
    fail('DIRECT_URL must use the pinned Supabase migration role');
  }
  if (runtimeUsername !== appRole && runtimeUsername !== `${appRole}.${projectRef}`) {
    fail('DATABASE_URL must use APP_DATABASE_ROLE on the pinned project');
  }

  return Object.freeze({
    directUrl: direct.raw,
    runtimeUrl: runtime.raw,
    projectRef,
    expectedSystemIdentifier,
    expectedDatabaseOid,
    expectedDatabaseName,
    appRole,
  });
}

export function decodeM1BStagingDatabaseIdentity(value, source) {
  let payload;
  try {
    payload = typeof value === 'string' ? JSON.parse(value.trim()) : value;
  } catch {
    fail(`${source} returned invalid identity JSON`);
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !SYSTEM_IDENTIFIER.test(payload.systemIdentifier ?? '') ||
    !Number.isSafeInteger(payload.databaseOid) ||
    payload.databaseOid <= 0 ||
    payload.databaseOid > 4_294_967_295 ||
    typeof payload.databaseName !== 'string' ||
    !DATABASE_NAME.test(payload.databaseName) ||
    payload.serverEncoding !== 'UTF8' ||
    typeof payload.inRecovery !== 'boolean' ||
    typeof payload.transactionReadOnly !== 'boolean' ||
    typeof payload.sessionUser !== 'string' ||
    typeof payload.currentUser !== 'string' ||
    typeof payload.roleSuperuser !== 'boolean' ||
    typeof payload.roleBypassRls !== 'boolean'
  ) {
    fail(`${source} returned a malformed database identity`);
  }
  if (payload.inRecovery || payload.transactionReadOnly) {
    fail(`${source} is not the writable primary`);
  }
  return Object.freeze(payload);
}

export function assertM1BStagingDatabaseIdentity(config, direct, runtime) {
  for (const [field, expected] of [
    ['systemIdentifier', config.expectedSystemIdentifier],
    ['databaseOid', config.expectedDatabaseOid],
    ['databaseName', config.expectedDatabaseName],
  ]) {
    if (direct[field] !== expected || runtime[field] !== expected) {
      fail(`the staging database pin mismatched ${field}`);
    }
  }
  if (direct.currentUser !== 'postgres' || direct.sessionUser !== 'postgres') {
    fail('DIRECT_URL did not connect as the migration role');
  }
  if (direct.roleSuperuser) {
    fail('DIRECT_URL staging certification requires the real non-superuser Supabase deployer');
  }
  if (!direct.roleBypassRls) {
    fail('DIRECT_URL cannot prove global state through forced RLS without BYPASSRLS');
  }
  if (
    runtime.currentUser !== config.appRole ||
    runtime.sessionUser !== config.appRole ||
    runtime.roleSuperuser ||
    runtime.roleBypassRls
  ) {
    fail('DATABASE_URL did not connect as the restricted runtime role');
  }
  return Object.freeze({
    systemIdentifier: config.expectedSystemIdentifier,
    databaseOid: config.expectedDatabaseOid,
    databaseName: config.expectedDatabaseName,
  });
}

function queryIdentity(url, source, environment, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = withPsqlChildEnvironment(url, environment, (childEnvironment) =>
    spawn(
      'psql',
      ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
      boundedPsqlSpawnOptions(childEnvironment, {
        input: IDENTITY_SQL,
        encoding: 'utf8',
      }),
    ),
  );
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql failed')
      .replaceAll(url, '[redacted]')
      .trim();
    fail(`${source} identity query failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  const rows = String(result.stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1) fail(`${source} did not return exactly one identity`);
  return decodeM1BStagingDatabaseIdentity(rows[0], source);
}

export function certifyM1BStagingDatabase(environment = process.env, dependencies = {}) {
  const config = parseM1BStagingDatabaseEnvironment(environment);
  const direct = queryIdentity(
    config.directUrl,
    'DIRECT_URL',
    environment,
    dependencies,
  );
  const runtime = queryIdentity(
    config.runtimeUrl,
    'DATABASE_URL',
    environment,
    dependencies,
  );
  return assertM1BStagingDatabaseIdentity(config, direct, runtime);
}

function main() {
  certifyM1BStagingDatabase();
  process.stdout.write('agent-mission-m1b-staging-database:ok:pinned\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'agent-mission-m1b-staging-database:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}
