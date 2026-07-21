import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SYSTEM_IDENTIFIER = /^\d+$/u;

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
