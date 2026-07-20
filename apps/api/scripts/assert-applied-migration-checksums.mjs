import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const migrationsDirectory = new URL('../prisma/migrations/', import.meta.url);

export function parseAppliedMigrationRows(raw) {
  if (raw.trim() === '') return [];
  return raw.trim().split('\n').map((line) => {
    const [name, checksum, ...unexpected] = line.split('|');
    if (
      unexpected.length > 0
      || name === undefined
      || checksum === undefined
      || !MIGRATION_NAME.test(name)
      || !CHECKSUM.test(checksum)
    ) {
      throw new Error(`invalid_applied_migration_row:${line}`);
    }
    return Object.freeze({ name, checksum });
  });
}

export function assertAppliedMigrationChecksums({ applied, local, allowPendingLocal = false }) {
  if (local.size === 0) throw new Error('local_migration_set_is_empty');
  if (!allowPendingLocal && applied.length === 0) throw new Error('applied_migration_set_is_empty');

  const appliedByName = new Map();
  for (const migration of applied) {
    if (appliedByName.has(migration.name)) {
      throw new Error(`duplicate_applied_migration:${migration.name}`);
    }
    appliedByName.set(migration.name, migration.checksum);
    const localChecksum = local.get(migration.name);
    if (localChecksum === undefined) throw new Error(`applied_migration_file_missing:${migration.name}`);
    if (localChecksum !== migration.checksum) {
      throw new Error(`migration_checksum_mismatch:${migration.name}`);
    }
  }
  if (!allowPendingLocal) {
    for (const name of local.keys()) {
      if (!appliedByName.has(name)) throw new Error(`migration_not_applied:${name}`);
    }
  }
  return Object.freeze({
    appliedCount: appliedByName.size,
    pendingCount: local.size - appliedByName.size,
  });
}

export async function readLocalMigrationChecksums() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const local = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!MIGRATION_NAME.test(entry.name)) throw new Error(`invalid_local_migration_name:${entry.name}`);
    const bytes = await readFile(new URL(`${entry.name}/migration.sql`, migrationsDirectory));
    local.set(entry.name, createHash('sha256').update(bytes).digest('hex'));
  }
  return local;
}

function psql(directUrl, sql) {
  try {
    return execFileSync('psql', [
      directUrl,
      '-X',
      '-qAt',
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    throw new Error('applied_migration_query_failed');
  }
}

function readAppliedMigrationRows(directUrl) {
  const exists = psql(
    directUrl,
    `SELECT pg_catalog.to_regclass('public."_prisma_migrations"') IS NOT NULL`,
  ).trim();
  if (exists === 'f') return [];
  if (exists !== 't') throw new Error('invalid_prisma_migration_table_probe');
  return parseAppliedMigrationRows(psql(
    directUrl,
    `SELECT migration_name, checksum
       FROM public."_prisma_migrations"
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL
      ORDER BY migration_name`,
  ));
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  const directUrl = process.env.DIRECT_URL?.trim();
  if (!directUrl) throw new Error('DIRECT_URL is required');
  const args = process.argv.slice(2);
  const allowPendingLocal = args.includes('--allow-pending-local');
  if (args.some((argument) => argument !== '--allow-pending-local')) {
    throw new Error('unsupported_checksum_guard_argument');
  }
  const result = assertAppliedMigrationChecksums({
    applied: readAppliedMigrationRows(directUrl),
    local: await readLocalMigrationChecksums(),
    allowPendingLocal,
  });
  process.stdout.write(
    `Migration checksums OK: ${result.appliedCount} applied, ${result.pendingCount} pending.\n`,
  );
}
