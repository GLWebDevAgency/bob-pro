import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const QUERY_PARAMETER_ENVIRONMENT = Object.freeze({
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  client_encoding: 'PGCLIENTENCODING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  gssdelegation: 'PGGSSDELEGATION',
  gssencmode: 'PGGSSENCMODE',
  gsslib: 'PGGSSLIB',
  krbsrvname: 'PGKRBSRVNAME',
  load_balance_hosts: 'PGLOADBALANCEHOSTS',
  max_protocol_version: 'PGMAXPROTOCOLVERSION',
  min_protocol_version: 'PGMINPROTOCOLVERSION',
  options: 'PGOPTIONS',
  require_auth: 'PGREQUIREAUTH',
  requirepeer: 'PGREQUIREPEER',
  ssl_min_protocol_version: 'PGSSLMINPROTOCOLVERSION',
  ssl_max_protocol_version: 'PGSSLMAXPROTOCOLVERSION',
  sslcert: 'PGSSLCERT',
  sslcertmode: 'PGSSLCERTMODE',
  sslcompression: 'PGSSLCOMPRESSION',
  sslcrl: 'PGSSLCRL',
  sslcrldir: 'PGSSLCRLDIR',
  sslkey: 'PGSSLKEY',
  sslmode: 'PGSSLMODE',
  sslnegotiation: 'PGSSLNEGOTIATION',
  sslrootcert: 'PGSSLROOTCERT',
  sslsni: 'PGSSLSNI',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
});

const CONNECTION_ALIASES = Object.freeze([
  'DATABASE_URL',
  'DIRECT_URL',
  'PGDATABASE',
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  ...Object.values(QUERY_PARAMETER_ENVIRONMENT),
]);

function invalidConnectionUrl() {
  throw new TypeError('PostgreSQL connection URL is missing or invalid');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    invalidConnectionUrl();
  }
}

function nonEmptyConnectionValue(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8_192 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseConnectionUrl(connectionUrl) {
  if (
    typeof connectionUrl !== 'string' ||
    connectionUrl.length < 1 ||
    connectionUrl.length > 8_192 ||
    connectionUrl !== connectionUrl.trim() ||
    /[\u0000-\u001f\u007f]/u.test(connectionUrl)
  ) {
    invalidConnectionUrl();
  }
  let parsed;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    invalidConnectionUrl();
  }
  const hostname = safeDecode(parsed.hostname.replace(/^\[|\]$/gu, ''));
  const username = safeDecode(parsed.username);
  const password = safeDecode(parsed.password);
  const database = safeDecode(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !nonEmptyConnectionValue(hostname) ||
    hostname.includes(',') ||
    !nonEmptyConnectionValue(username) ||
    (password.length > 0 && !nonEmptyConnectionValue(password)) ||
    !nonEmptyConnectionValue(database) ||
    database.includes('/') ||
    parsed.hash.length > 0
  ) {
    invalidConnectionUrl();
  }

  const queryEnvironment = {};
  const seen = new Set();
  for (const [name, value] of parsed.searchParams) {
    const environmentName = QUERY_PARAMETER_ENVIRONMENT[name];
    if (
      environmentName === undefined ||
      seen.has(name) ||
      !nonEmptyConnectionValue(value)
    ) {
      invalidConnectionUrl();
    }
    seen.add(name);
    queryEnvironment[environmentName] = value;
  }

  return Object.freeze({
    hostname,
    port: parsed.port,
    database,
    username,
    password,
    queryEnvironment: Object.freeze(queryEnvironment),
  });
}

function escapePasswordFileField(value) {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

export function withPsqlChildEnvironment(
  connectionUrl,
  environment = process.env,
  operation,
) {
  if (typeof operation !== 'function') {
    throw new TypeError('psql child operation is required');
  }
  const connection = parseConnectionUrl(connectionUrl);
  const child = { ...environment };
  for (const name of CONNECTION_ALIASES) delete child[name];
  child.PGHOST = connection.hostname;
  if (connection.port.length > 0) child.PGPORT = connection.port;
  child.PGDATABASE = connection.database;
  child.PGUSER = connection.username;
  Object.assign(child, connection.queryEnvironment);

  let secretDirectory = null;
  try {
    if (connection.password.length > 0) {
      secretDirectory = mkdtempSync(join(tmpdir(), 'bob-psql-'));
      chmodSync(secretDirectory, 0o700);
      const passwordFile = join(secretDirectory, 'pgpass');
      const line = [
        connection.hostname,
        connection.port || '*',
        connection.database,
        connection.username,
        connection.password,
      ]
        .map(escapePasswordFileField)
        .join(':');
      writeFileSync(passwordFile, `${line}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      child.PGPASSFILE = passwordFile;
    }

    const result = operation(child);
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      throw new TypeError('psql child operation must be synchronous');
    }
    return result;
  } finally {
    if (secretDirectory !== null) {
      rmSync(secretDirectory, { force: true, recursive: true, maxRetries: 2 });
    }
  }
}
