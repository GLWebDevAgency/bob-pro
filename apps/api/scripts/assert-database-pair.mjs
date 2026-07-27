import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SYSTEM_IDENTIFIER = /^\d+$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SUPABASE_CI_DATABASES = new Set([
  '/bob_ephemeral_ci',
  '/bob_ephemeral_global_capacity',
  '/bob_ephemeral_key_rotation',
]);

function parseEphemeralPostgresUrl(
  raw,
  { source, expectedUser, expectedPassword, allowedDatabases },
) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`ephemeral_database_url_required:${source}`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ephemeral_database_url_invalid:${source}`);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`ephemeral_database_url_protocol:${source}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`ephemeral_database_url_must_be_loopback:${source}`);
  }
  if (parsed.port === '') {
    throw new Error(`ephemeral_database_url_requires_explicit_port:${source}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`ephemeral_database_url_forbids_parameters:${source}`);
  }
  if (!allowedDatabases.has(parsed.pathname)) {
    throw new Error(`ephemeral_database_url_database_not_allowlisted:${source}`);
  }

  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error(`ephemeral_database_url_credentials_invalid:${source}`);
  }
  if (username !== expectedUser || password !== expectedPassword) {
    throw new Error(`ephemeral_database_url_identity_mismatch:${source}`);
  }

  return Object.freeze({
    hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  });
}

export function assertEphemeralSupabaseCiUrls({ mode, environment }) {
  const ownerSplitDatabases = new Set(['/bob_ephemeral_ci']);
  const specifications = mode === 'bootstrap'
    ? [
        ['CI_POSTGRES_SUPER_URL', 'postgres', 'postgres', SUPABASE_CI_DATABASES],
        [
          'CI_POSTGRES_ADMIN_URL',
          'bob_ci_supabase_admin',
          'bob_ci_supabase_admin',
          SUPABASE_CI_DATABASES,
        ],
        ['DIRECT_URL', 'postgres', 'postgres', SUPABASE_CI_DATABASES],
      ]
    : mode === 'owner-split'
      ? [
          ['DIRECT_URL', 'postgres', 'postgres', ownerSplitDatabases],
          ['DATABASE_URL', 'bob_app', 'bob_app', ownerSplitDatabases],
        ]
      : null;

  if (specifications === null) {
    throw new Error('ephemeral_database_mode_must_be_bootstrap_or_owner_split');
  }

  const parsed = specifications.map(
    ([source, expectedUser, expectedPassword, allowedDatabases]) => parseEphemeralPostgresUrl(
      environment[source],
      { source, expectedUser, expectedPassword, allowedDatabases },
    ),
  );
  const [expected, ...others] = parsed;
  for (const candidate of others) {
    if (
      candidate.hostname !== expected.hostname
      || candidate.port !== expected.port
      || candidate.pathname !== expected.pathname
    ) {
      throw new Error('ephemeral_database_urls_must_target_same_database');
    }
  }

  return Object.freeze({
    databaseName: expected.pathname.slice(1),
    endpoint: `${expected.hostname}:${expected.port}`,
  });
}

export function parseDatabaseIdentity(raw, source) {
  let value;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error(`database_identity_invalid_json:${source}`);
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !SYSTEM_IDENTIFIER.test(value.systemIdentifier ?? '')
    || !Number.isInteger(value.databaseOid)
    || value.databaseOid <= 0
    || typeof value.databaseName !== 'string'
    || value.databaseName.length === 0
    || typeof value.serverEncoding !== 'string'
    || typeof value.inRecovery !== 'boolean'
    || typeof value.transactionReadOnly !== 'boolean'
  ) {
    throw new Error(`database_identity_malformed:${source}`);
  }
  return Object.freeze(value);
}

export function assertDatabasePair({ direct, runtime }) {
  for (const [source, identity] of [['DIRECT_URL', direct], ['DATABASE_URL', runtime]]) {
    if (identity.serverEncoding !== 'UTF8') {
      throw new Error(`database_encoding_must_be_utf8:${source}`);
    }
    if (identity.inRecovery || identity.transactionReadOnly) {
      throw new Error(`database_connection_must_be_writable_primary:${source}`);
    }
  }
  for (const field of ['systemIdentifier', 'databaseOid', 'databaseName']) {
    if (direct[field] !== runtime[field]) {
      throw new Error(`database_connection_identity_mismatch:${field}`);
    }
  }
  return Object.freeze({
    systemIdentifier: direct.systemIdentifier,
    databaseOid: direct.databaseOid,
    databaseName: direct.databaseName,
  });
}

function readDatabaseIdentity(url, source) {
  const sql = `
    SELECT pg_catalog.json_build_object(
      'systemIdentifier', control.system_identifier::text,
      'databaseOid', database.oid::bigint,
      'databaseName', pg_catalog.current_database(),
      'serverEncoding', pg_catalog.current_setting('server_encoding'),
      'inRecovery', pg_catalog.pg_is_in_recovery(),
      'transactionReadOnly', pg_catalog.current_setting('transaction_read_only') = 'on'
    )::text
      FROM pg_catalog.pg_control_system() AS control
      JOIN pg_catalog.pg_database AS database
        ON database.datname = pg_catalog.current_database()
  `;
  let raw;
  try {
    raw = execFileSync('psql', [
      url,
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    throw new Error(`database_identity_query_failed:${source}`);
  }
  return parseDatabaseIdentity(raw, source);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  if (process.argv[2] === '--ephemeral-supabase-ci') {
    const result = assertEphemeralSupabaseCiUrls({
      mode: process.argv[3],
      environment: process.env,
    });
    process.stdout.write(
      `Ephemeral Supabase CI target OK: ${result.databaseName} on ${result.endpoint}.\n`,
    );
    process.exit(0);
  }
  if (process.argv.length > 2) {
    throw new Error('unsupported_assert_database_pair_arguments');
  }
  const directUrl = process.env.DIRECT_URL?.trim();
  const runtimeUrl = process.env.DATABASE_URL?.trim();
  if (!directUrl) throw new Error('DIRECT_URL is required');
  if (!runtimeUrl) throw new Error('DATABASE_URL is required');
  const result = assertDatabasePair({
    direct: readDatabaseIdentity(directUrl, 'DIRECT_URL'),
    runtime: readDatabaseIdentity(runtimeUrl, 'DATABASE_URL'),
  });
  process.stdout.write(
    `Database identity OK: ${result.databaseName} on PostgreSQL system ${result.systemIdentifier}.\n`,
  );
}
