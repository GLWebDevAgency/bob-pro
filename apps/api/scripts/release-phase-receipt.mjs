#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RECEIPT_PATH = resolve(REPOSITORY_ROOT, '.release-evidence/api/predeploy-receipt.json');
const PRIVATE_BINDING_PATH = resolve(
  REPOSITORY_ROOT,
  '.release-evidence-private/api/predeploy-secret-binding.json',
);
const RELEASE_SURFACES = Object.freeze([
  'apps/api/package.json',
  'apps/api/prisma',
  'apps/api/scripts',
  'apps/api/src/persistence/prisma',
  'pnpm-lock.yaml',
]);
const RECEIPT_KEYS = Object.freeze([
  'certificationMode',
  'completedAt',
  'database',
  'migrationStateDigest',
  'phase',
  'releaseEnvironment',
  'releaseSha',
  'runtimeConfigurationDigest',
  'releaseSurfaceDigest',
  'runAttempt',
  'runId',
  'version',
]);
const DATABASE_KEYS = Object.freeze([
  'databaseName',
  'databaseOid',
  'systemIdentifier',
  'usedSessionsAtCertification',
]);
const PRIVATE_BINDING_KEYS = Object.freeze([
  'completedAt',
  'releaseEnvironment',
  'releaseSha',
  'runAttempt',
  'runId',
  'secretMaterialDigest',
  'version',
]);
const SHA_256 = /^[a-f0-9]{64}$/u;
const RELEASE_SHA = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const SYSTEM_IDENTIFIER = /^\d+$/u;
const MIGRATION_ROW = /^\d{14}_[a-z0-9_]+\|[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 8_192;
const MAX_RECEIPT_AGE_MILLISECONDS = 6 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MILLISECONDS = 60_000;
const RUNTIME_CONFIGURATION_KEYS = Object.freeze([
  'BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED',
  'BOB_AGENT_MISSION_HMAC_KEY_VERSION',
  'BOB_AGENT_MISSION_MAX_VERSIONED_KEYS',
  'BOB_LIVE_ACTIVE_LEASE_SECONDS',
  'BOB_LIVE_AUDIT_PROVIDER',
  'BOB_LIVE_CAPACITY_CONFIG_VERSION',
  'BOB_LIVE_CONTROL_ENCRYPTION_KEY_VERSION',
  'BOB_LIVE_CONTROL_TIMEOUT_MS',
  'BOB_LIVE_ENABLED',
  'BOB_LIVE_GATEWAY_MAX_CONNECTIONS',
  'BOB_LIVE_GATEWAY_SHUTDOWN_GRACE_MS',
  'BOB_LIVE_GATEWAY_TLS_MODE',
  'BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS',
  'BOB_LIVE_HEARTBEAT_SECONDS',
  'BOB_LIVE_LOCAL_AUDIT_BASE_URL',
  'BOB_LIVE_MAX_CALLS_PER_HOUR',
  'BOB_LIVE_MAX_CALLS_PER_MINUTE',
  'BOB_LIVE_MAX_SESSION_SECONDS',
  'BOB_LIVE_MAX_TENANT_CALLS_PER_HOUR',
  'BOB_LIVE_MAX_TENANT_CALLS_PER_MINUTE',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES',
  'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION',
  'BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED',
  'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION',
  'BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED',
  'BOB_LIVE_MISTRAL_WEBSOCKET_URL',
  'BOB_LIVE_PROOF_KEY_VERSION',
  'BOB_LIVE_PROOF_MAX_VERSIONED_KEYS',
  'BOB_LIVE_PROVIDER',
  'BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS',
  'BOB_LIVE_PROVIDER_TIMEOUT_MS',
  'BOB_LIVE_REAPER_LEASE_SECONDS',
  'BOB_LIVE_RESERVATION_TTL_SECONDS',
  'BOB_LIVE_SPEECH_DELIVERY',
  'BOB_LIVE_SUBJECT_KEY_VERSION',
  'BOB_LIVE_SUBJECT_MAX_VERSIONED_KEYS',
  'BOB_LIVE_USAGE_KEY_VERSION',
  'MISTRAL_REALTIME_BASE_URL',
  'MISTRAL_REALTIME_STT_MODEL',
  'MISTRAL_REALTIME_TARGET_DELAY_MS',
  'MISTRAL_TTS_MODEL',
  'MISTRAL_TTS_VOICE_ID',
  'MISTRAL_V2_MAX_VERSIONED_KEYS',
  'OPENAI_NATIVE_WEBRTC_RUNTIME_READY',
  'OPENAI_REALTIME_ACTIVE_LEASE_SECONDS',
  'OPENAI_REALTIME_BASE_URL',
  'OPENAI_REALTIME_CONTROL_ENCRYPTION_KEY_VERSION',
  'OPENAI_REALTIME_ENABLED',
  'OPENAI_REALTIME_HEARTBEAT_SECONDS',
  'OPENAI_REALTIME_MAX_CALLS_PER_HOUR',
  'OPENAI_REALTIME_MAX_CALLS_PER_MINUTE',
  'OPENAI_REALTIME_MAX_SESSION_SECONDS',
  'OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR',
  'OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE',
  'OPENAI_REALTIME_MODEL',
  'OPENAI_REALTIME_PROOF_KEY_VERSION',
  'OPENAI_REALTIME_PROVIDER_TIMEOUT_MS',
  'OPENAI_REALTIME_REAPER_LEASE_SECONDS',
  'OPENAI_REALTIME_RESERVATION_TTL_SECONDS',
  'OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS',
  'OPENAI_REALTIME_VOICE',
  'OPENAI_TTS_MODEL',
]);
const VERSIONED_KEYRING_KEYS = Object.freeze([
  'BOB_AGENT_MISSION_HMAC_KEYRING',
  'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
  'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
  'BOB_LIVE_PROOF_KEYRING',
  'BOB_LIVE_SUBJECT_HMAC_KEYRING',
]);
const RUNTIME_SCALAR_SECRET_MATERIAL_KEYS = Object.freeze([
  'BOB_LIVE_CONTROL_ENCRYPTION_SECRET',
  'BOB_LIVE_USAGE_HMAC_SECRET',
  'OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET',
]);

function fail(code) {
  throw new Error(`release_phase_receipt:${code}`);
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function parseVersionedKeyring(raw) {
  let keyring;
  try {
    keyring = JSON.parse(raw);
  } catch {
    fail('runtime_keyring_invalid');
  }
  if (
    keyring === null ||
    typeof keyring !== 'object' ||
    Array.isArray(keyring) ||
    Object.getPrototypeOf(keyring) !== Object.prototype
  ) {
    fail('runtime_keyring_invalid');
  }
  const entries = Object.entries(keyring).sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  );
  if (
    entries.length === 0 ||
    entries.some(
      ([version, secret]) =>
        !POSITIVE_INTEGER.test(version) || typeof secret !== 'string' || secret.length === 0,
    )
  ) {
    fail('runtime_keyring_invalid');
  }
  return entries;
}

export function requiredEnvironment(environment = process.env) {
  const releaseSha = (environment.BOB_RELEASE_SHA ?? environment.GITHUB_SHA ?? '').trim();
  const runId = (environment.BOB_RELEASE_RUN_ID ?? environment.GITHUB_RUN_ID ?? '').trim();
  const runAttempt = (
    environment.BOB_RELEASE_RUN_ATTEMPT ??
    environment.GITHUB_RUN_ATTEMPT ??
    ''
  ).trim();
  const releaseEnvironment = (environment.CABINET_RELEASE_ENV ?? '').trim();
  const expectedEnvironment = (environment.BOB_RELEASE_EXPECTED_ENV ?? '').trim();
  if (!RELEASE_SHA.test(releaseSha)) fail('release_sha_invalid');
  if (!POSITIVE_INTEGER.test(runId)) fail('run_id_invalid');
  if (!POSITIVE_INTEGER.test(runAttempt)) fail('run_attempt_invalid');
  if (!['development', 'staging', 'production'].includes(releaseEnvironment)) {
    fail('release_environment_invalid');
  }
  if (!['development', 'staging', 'production'].includes(expectedEnvironment)) {
    fail('expected_release_environment_invalid');
  }
  if (releaseEnvironment !== expectedEnvironment) fail('release_environment_mismatch');
  return Object.freeze({
    certificationMode:
      releaseEnvironment === 'production' ? 'production-readonly' : 'nonproduction-full',
    releaseEnvironment,
    releaseSha,
    runAttempt: Number(runAttempt),
    runId,
  });
}

export function runtimeConfigurationDigest(environment = process.env) {
  const entries = RUNTIME_CONFIGURATION_KEYS.map((name) => [
    name,
    environment[name] === undefined ? null : environment[name],
  ]);
  for (const name of VERSIONED_KEYRING_KEYS) {
    const raw = environment[name];
    if (raw === undefined) {
      entries.push([`${name}#versions`, null]);
      continue;
    }
    const versions = parseVersionedKeyring(raw).map(([version]) => version);
    entries.push([`${name}#versions`, versions.join(',')]);
  }
  const digest = createHash('sha256');
  for (const [name, value] of entries) {
    if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) {
      fail('runtime_configuration_invalid');
    }
    const canonicalValue = value === null ? '<absent>' : value;
    digest.update(String(Buffer.byteLength(name, 'utf8')), 'utf8');
    digest.update(':', 'utf8');
    digest.update(name, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(String(Buffer.byteLength(canonicalValue, 'utf8')), 'utf8');
    digest.update(':', 'utf8');
    digest.update(canonicalValue, 'utf8');
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
}

/**
 * Liaison privée inter-phases. Ce digest ne quitte jamais le runner et n'est jamais placé dans
 * l'artefact de preuve public : il détecte une rotation concurrente des secrets scalaires ou du
 * matériau d'un keyring à numéro de version inchangé.
 */
export function runtimeSecretMaterialDigest(environment = process.env) {
  const digest = createHash('sha256');
  for (const name of RUNTIME_SCALAR_SECRET_MATERIAL_KEYS) {
    const value = environment[name] === undefined ? '<absent>' : environment[name];
    if (typeof value !== 'string') fail('runtime_secret_material_invalid');
    digest.update(String(Buffer.byteLength(name, 'utf8')), 'utf8');
    digest.update(':', 'utf8');
    digest.update(name, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(String(Buffer.byteLength(value, 'utf8')), 'utf8');
    digest.update(':', 'utf8');
    digest.update(value, 'utf8');
    digest.update('\0', 'utf8');
  }
  for (const name of VERSIONED_KEYRING_KEYS) {
    const raw = environment[name];
    const entries = raw === undefined ? [] : parseVersionedKeyring(raw);
    digest.update(String(Buffer.byteLength(name, 'utf8')), 'utf8');
    digest.update(':', 'utf8');
    digest.update(name, 'utf8');
    digest.update('\0', 'utf8');
    if (raw === undefined) {
      digest.update('8:<absent>\0', 'utf8');
      continue;
    }
    for (const [version, secret] of entries) {
      digest.update(String(Buffer.byteLength(version, 'utf8')), 'utf8');
      digest.update(':', 'utf8');
      digest.update(version, 'utf8');
      digest.update('\0', 'utf8');
      digest.update(String(Buffer.byteLength(secret, 'utf8')), 'utf8');
      digest.update(':', 'utf8');
      digest.update(secret, 'utf8');
      digest.update('\0', 'utf8');
    }
  }
  return digest.digest('hex');
}

function regularFiles(entryPath) {
  const absolute = resolve(REPOSITORY_ROOT, entryPath);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) fail('release_surface_symlink_forbidden');
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) fail('release_surface_type_invalid');
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = resolve(absolute, entry.name);
    if (entry.isSymbolicLink()) fail('release_surface_symlink_forbidden');
    if (entry.isDirectory()) files.push(...regularFiles(relative(REPOSITORY_ROOT, child)));
    else if (entry.isFile()) files.push(child);
    else fail('release_surface_type_invalid');
  }
  return files;
}

export function computeReleaseSurfaceDigest() {
  const files = RELEASE_SURFACES.flatMap(regularFiles).sort((left, right) =>
    relative(REPOSITORY_ROOT, left).localeCompare(relative(REPOSITORY_ROOT, right), 'en'),
  );
  if (files.length === 0) fail('release_surface_empty');
  const digest = createHash('sha256');
  for (const file of files) {
    const repositoryPath = relative(REPOSITORY_ROOT, file).replaceAll('\\', '/');
    const bytes = readFileSync(file);
    digest.update(repositoryPath, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(String(bytes.length), 'utf8');
    digest.update('\0', 'utf8');
    digest.update(bytes);
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
}

function psql(directUrl, sql) {
  try {
    return withPsqlChildEnvironment(directUrl, process.env, (childEnvironment) =>
      execFileSync(
        'psql',
        ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        boundedPsqlSpawnOptions(childEnvironment, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
        }),
      ),
    );
  } catch {
    fail('database_query_failed');
  }
}

export function parseDatabaseSnapshot(raw) {
  let value;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    fail('database_snapshot_invalid_json');
  }
  exactKeys(
    value,
    ['capacityMode', 'databaseName', 'databaseOid', 'systemIdentifier', 'usedSessions'],
    'database_snapshot_malformed',
  );
  if (
    !SYSTEM_IDENTIFIER.test(value.systemIdentifier) ||
    !Number.isInteger(value.databaseOid) ||
    value.databaseOid < 1 ||
    typeof value.databaseName !== 'string' ||
    value.databaseName.length < 1 ||
    value.capacityMode !== 'closed' ||
    !Number.isInteger(value.usedSessions) ||
    value.usedSessions < 0
  ) {
    fail('database_snapshot_malformed');
  }
  return Object.freeze(value);
}

function readDatabaseSnapshot(directUrl) {
  return parseDatabaseSnapshot(
    psql(
      directUrl,
      `
      BEGIN;
      SET LOCAL statement_timeout = '5s';
      SET LOCAL lock_timeout = '2s';
      -- L'autorité globale n'est volontairement pas lisible par le déployeur Supabase après le
      -- transfert d'ownership. L'adhésion SET implicite créée avec ce rôle est le seul accès
      -- administratif autorisé, comme pour toutes ses mutations de release.
      SET LOCAL ROLE bob_realtime_capacity;
      SELECT pg_catalog.json_build_object(
        'systemIdentifier', control.system_identifier::text,
        'databaseOid', database.oid::bigint,
        'databaseName', pg_catalog.current_database(),
        'capacityMode', capacity.mode::text,
        'usedSessions', capacity."usedSessions"
      )::text
        FROM pg_catalog.pg_control_system() AS control
        JOIN pg_catalog.pg_database AS database
          ON database.datname = pg_catalog.current_database()
        JOIN public.realtime_global_capacity AS capacity
          ON capacity.id = 1
      ;
      COMMIT;
      `,
    ),
  );
}

export function migrationStateDigest(raw) {
  const rows = raw.trim() === '' ? [] : raw.trim().split('\n');
  if (rows.length === 0 || rows.some((row) => !MIGRATION_ROW.test(row))) {
    fail('migration_state_malformed');
  }
  const sorted = [...rows].sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(sorted).size !== sorted.length) fail('migration_state_duplicate');
  return createHash('sha256')
    .update(`${sorted.join('\n')}\n`, 'utf8')
    .digest('hex');
}

function readMigrationStateDigest(directUrl) {
  return migrationStateDigest(
    psql(
      directUrl,
      `
      SELECT migration_name || '|' || checksum
        FROM public."_prisma_migrations"
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL
       ORDER BY migration_name
    `,
    ),
  );
}

export function createReceipt({
  context,
  databaseSnapshot,
  migrationDigest,
  runtimeDigest,
  surfaceDigest,
  completedAt = new Date(),
}) {
  if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
    fail('completed_at_invalid');
  }
  if (!SHA_256.test(migrationDigest)) fail('migration_digest_invalid');
  if (!SHA_256.test(runtimeDigest)) fail('runtime_configuration_digest_invalid');
  if (!SHA_256.test(surfaceDigest)) fail('surface_digest_invalid');
  return Object.freeze({
    version: 1,
    phase: 'predeploy',
    releaseSha: context.releaseSha,
    releaseEnvironment: context.releaseEnvironment,
    runId: context.runId,
    runAttempt: context.runAttempt,
    certificationMode: context.certificationMode,
    database: Object.freeze({
      systemIdentifier: databaseSnapshot.systemIdentifier,
      databaseOid: databaseSnapshot.databaseOid,
      databaseName: databaseSnapshot.databaseName,
      usedSessionsAtCertification: databaseSnapshot.usedSessions,
    }),
    migrationStateDigest: migrationDigest,
    runtimeConfigurationDigest: runtimeDigest,
    releaseSurfaceDigest: surfaceDigest,
    completedAt: completedAt.toISOString(),
  });
}

export function createPrivateSecretBinding({ context, secretDigest, completedAt = new Date() }) {
  if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
    fail('private_binding_completed_at_invalid');
  }
  if (!SHA_256.test(secretDigest)) fail('private_binding_digest_invalid');
  return Object.freeze({
    version: 1,
    releaseSha: context.releaseSha,
    releaseEnvironment: context.releaseEnvironment,
    runId: context.runId,
    runAttempt: context.runAttempt,
    secretMaterialDigest: secretDigest,
    completedAt: completedAt.toISOString(),
  });
}

export function parseReceipt(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) fail('receipt_too_large');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('receipt_invalid_json');
  }
  exactKeys(value, RECEIPT_KEYS, 'receipt_shape_invalid');
  exactKeys(value.database, DATABASE_KEYS, 'receipt_database_shape_invalid');
  if (
    value.version !== 1 ||
    value.phase !== 'predeploy' ||
    !RELEASE_SHA.test(value.releaseSha) ||
    !['development', 'staging', 'production'].includes(value.releaseEnvironment) ||
    !POSITIVE_INTEGER.test(value.runId) ||
    !Number.isInteger(value.runAttempt) ||
    value.runAttempt < 1 ||
    !['nonproduction-full', 'production-readonly'].includes(value.certificationMode) ||
    !SYSTEM_IDENTIFIER.test(value.database.systemIdentifier) ||
    !Number.isInteger(value.database.databaseOid) ||
    value.database.databaseOid < 1 ||
    typeof value.database.databaseName !== 'string' ||
    value.database.databaseName.length < 1 ||
    !Number.isInteger(value.database.usedSessionsAtCertification) ||
    value.database.usedSessionsAtCertification < 0 ||
    !SHA_256.test(value.migrationStateDigest) ||
    !SHA_256.test(value.runtimeConfigurationDigest) ||
    !SHA_256.test(value.releaseSurfaceDigest) ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    fail('receipt_shape_invalid');
  }
  const expectedMode =
    value.releaseEnvironment === 'production' ? 'production-readonly' : 'nonproduction-full';
  if (value.certificationMode !== expectedMode) fail('receipt_mode_invalid');
  return Object.freeze({
    ...value,
    database: Object.freeze({ ...value.database }),
  });
}

export function assertReceiptMatches({
  receipt,
  context,
  databaseSnapshot,
  migrationDigest,
  runtimeDigest,
  surfaceDigest,
  now = new Date(),
}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('verification_time_invalid');
  if (
    receipt.releaseSha !== context.releaseSha ||
    receipt.releaseEnvironment !== context.releaseEnvironment ||
    receipt.runId !== context.runId ||
    receipt.runAttempt !== context.runAttempt ||
    receipt.certificationMode !== context.certificationMode
  ) {
    fail('receipt_context_mismatch');
  }
  if (
    receipt.database.systemIdentifier !== databaseSnapshot.systemIdentifier ||
    receipt.database.databaseOid !== databaseSnapshot.databaseOid ||
    receipt.database.databaseName !== databaseSnapshot.databaseName
  ) {
    fail('receipt_database_mismatch');
  }
  if (databaseSnapshot.capacityMode !== 'closed') fail('receipt_capacity_not_closed');
  if (receipt.migrationStateDigest !== migrationDigest) fail('receipt_migration_drift');
  if (receipt.runtimeConfigurationDigest !== runtimeDigest) {
    fail('receipt_runtime_configuration_drift');
  }
  if (receipt.releaseSurfaceDigest !== surfaceDigest) fail('receipt_surface_drift');
  const completedAt = Date.parse(receipt.completedAt);
  const age = now.getTime() - completedAt;
  if (age < -MAX_CLOCK_SKEW_MILLISECONDS || age > MAX_RECEIPT_AGE_MILLISECONDS) {
    fail('receipt_expired');
  }
  return receipt;
}

export function parsePrivateSecretBinding(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) {
    fail('private_binding_too_large');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('private_binding_invalid_json');
  }
  exactKeys(value, PRIVATE_BINDING_KEYS, 'private_binding_shape_invalid');
  if (
    value.version !== 1 ||
    !RELEASE_SHA.test(value.releaseSha) ||
    !['development', 'staging', 'production'].includes(value.releaseEnvironment) ||
    !POSITIVE_INTEGER.test(value.runId) ||
    !Number.isInteger(value.runAttempt) ||
    value.runAttempt < 1 ||
    !SHA_256.test(value.secretMaterialDigest) ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    fail('private_binding_shape_invalid');
  }
  return Object.freeze({ ...value });
}

export function assertPrivateSecretBindingMatches({
  binding,
  context,
  secretDigest,
  now = new Date(),
}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail('private_binding_verification_time_invalid');
  }
  if (
    binding.releaseSha !== context.releaseSha ||
    binding.releaseEnvironment !== context.releaseEnvironment ||
    binding.runId !== context.runId ||
    binding.runAttempt !== context.runAttempt
  ) {
    fail('private_binding_context_mismatch');
  }
  if (binding.secretMaterialDigest !== secretDigest) {
    fail('private_binding_secret_material_drift');
  }
  const completedAt = Date.parse(binding.completedAt);
  const age = now.getTime() - completedAt;
  if (age < -MAX_CLOCK_SKEW_MILLISECONDS || age > MAX_RECEIPT_AGE_MILLISECONDS) {
    fail('private_binding_expired');
  }
  return binding;
}

export function writeReceiptAtomically(receipt, path = RECEIPT_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function readReceipt(path = RECEIPT_PATH) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      fail('receipt_missing');
    }
    fail('receipt_file_unreadable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail('receipt_file_unsafe');
  }
  if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) fail('receipt_file_size_invalid');
  return parseReceipt(readFileSync(path, 'utf8'));
}

export function readPrivateSecretBinding(path = PRIVATE_BINDING_PATH) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      fail('private_binding_missing');
    }
    fail('private_binding_file_unreadable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail('private_binding_file_unsafe');
  }
  if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
    fail('private_binding_file_size_invalid');
  }
  return parsePrivateSecretBinding(readFileSync(path, 'utf8'));
}

function runtimeInputs(environment = process.env) {
  const directUrl = environment.DIRECT_URL?.trim();
  if (!directUrl) fail('direct_url_required');
  return Object.freeze({
    context: requiredEnvironment(environment),
    databaseSnapshot: readDatabaseSnapshot(directUrl),
    migrationDigest: readMigrationStateDigest(directUrl),
    runtimeDigest: runtimeConfigurationDigest(environment),
    secretDigest: runtimeSecretMaterialDigest(environment),
    surfaceDigest: computeReleaseSurfaceDigest(),
  });
}

function main() {
  const command = process.argv[2] ?? '';
  if (process.argv.length !== 3) fail('usage');
  if (command === 'preflight') {
    requiredEnvironment();
    process.stdout.write('Release phase receipt invocation is valid.\n');
    return;
  }
  if (command === 'clear') {
    requiredEnvironment();
    rmSync(RECEIPT_PATH, { force: true });
    rmSync(PRIVATE_BINDING_PATH, { force: true });
    process.stdout.write('Stale release phase receipt cleared.\n');
    return;
  }
  if (command === 'write') {
    const inputs = runtimeInputs();
    const completedAt = new Date();
    writeReceiptAtomically(
      createPrivateSecretBinding({
        context: inputs.context,
        secretDigest: inputs.secretDigest,
        completedAt,
      }),
      PRIVATE_BINDING_PATH,
    );
    writeReceiptAtomically(createReceipt({ ...inputs, completedAt }));
    process.stdout.write('Predeploy release phase receipt written.\n');
    return;
  }
  if (command === 'verify') {
    const inputs = runtimeInputs();
    assertReceiptMatches({ receipt: readReceipt(), ...inputs });
    assertPrivateSecretBindingMatches({
      binding: readPrivateSecretBinding(),
      context: inputs.context,
      secretDigest: inputs.secretDigest,
    });
    process.stdout.write('Predeploy release phase receipt verified.\n');
    return;
  }
  fail('usage');
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'release_phase_receipt:unknown';
    console.error(message);
    process.exitCode = 1;
  }
}
