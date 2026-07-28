#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  certifyM1BStagingDatabase,
  parseM1BStagingDatabaseEnvironment,
} from './agent-mission-m1b-staging-database.mjs';
import { withPsqlChildEnvironment } from './psql-child-environment.mjs';

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const RECONCILIATION_OUTCOME = /^(?:reconciled:11|already-reconciled:11)$/u;

export const M1B_STAGING_MIGRATION_RENAMES = Object.freeze([
  Object.freeze({
    oldName: '20260727030000_release_flag_cabinet_subject_revocation_fence',
    newName: '20260727130000_release_flag_cabinet_subject_revocation_fence',
    checksum: 'fea31a0a47c360004054fe97571eec46a04f3fe682b2170d096f90f5046e721f',
  }),
  Object.freeze({
    oldName: '20260727040000_agent_mission_realtime_lease_expand',
    newName: '20260727140000_agent_mission_realtime_lease_expand',
    checksum: 'eeeabc0eb680662b06acf5325e791e3635b20d000f90cb590217187d68b118be',
  }),
  Object.freeze({
    oldName: '20260727050000_agent_mission_realtime_lease_validate',
    newName: '20260727150000_agent_mission_realtime_lease_validate',
    checksum: '3d8c071f5f98de8b6244b26bbf84df3fae989508b0cc7587b1308a31ad5c21f2',
  }),
  Object.freeze({
    oldName: '20260727060000_realtime_admission_cancellation_fence_expand',
    newName: '20260727160000_realtime_admission_cancellation_fence_expand',
    checksum: 'e6942ade96c10e818a56d96d725a0cf1fc605a29ec62a6bcf5bc3fa71a370ab1',
  }),
  Object.freeze({
    oldName: '20260727070000_realtime_admission_cancellation_fence_validate',
    newName: '20260727170000_realtime_admission_cancellation_fence_validate',
    checksum: '4c389e97b88ee48180ba46c18fd4bb0620416ba26c00bd7941125ef5111a434a',
  }),
  Object.freeze({
    oldName: '20260727080000_agent_mission_event_command_namespace_expand',
    newName: '20260727180000_agent_mission_event_command_namespace_expand',
    checksum: '5e4a07e66e047573ccb1766f6a8c844fad8bfe0a128ce9312abac17a9d4f19c5',
  }),
  Object.freeze({
    oldName: '20260727090000_agent_mission_event_command_namespace_validate',
    newName: '20260727190000_agent_mission_event_command_namespace_validate',
    checksum: '1075698957985ba9c3a62d20ce8c6e37d447432f54f29107db3c5e1d61444651',
  }),
  Object.freeze({
    oldName: '20260727100000_agent_mission_event_command_namespace_cutover',
    newName: '20260727200000_agent_mission_event_command_namespace_cutover',
    checksum: '659d429c958276552266919ebeaedc2fe1e7f4e3ce2be850beadeda7e9591462',
  }),
  Object.freeze({
    oldName: '20260727110000_agent_mission_fingerprint_key_readiness',
    newName: '20260727210000_agent_mission_fingerprint_key_readiness',
    checksum: '9c3f84f38e47c46112405eb256d71c023698f9d8be8cce0a65d8b43233f1ef40',
  }),
  Object.freeze({
    oldName: '20260727120000_agent_mission_bootstrap_receipt_expand',
    newName: '20260727220000_agent_mission_bootstrap_receipt_expand',
    checksum: '0accc58055e433c7b5815afc97dfe8d56362064db12aad9c4959da2bb54b67d0',
  }),
  Object.freeze({
    oldName: '20260727130000_agent_mission_bootstrap_receipt_validate',
    newName: '20260727230000_agent_mission_bootstrap_receipt_validate',
    checksum: '0c4a8461aaf22a51cae19ae734533a50ed5206fd448850c4195adb36d8086749',
  }),
]);

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-migration-reconcile:${message}`);
}

function assertRenameMap(renameMap) {
  if (!Array.isArray(renameMap) || renameMap.length !== 11) {
    fail('the reviewed rename map must contain exactly eleven migrations');
  }
  const oldNames = new Set();
  const newNames = new Set();
  for (const entry of renameMap) {
    if (
      typeof entry !== 'object'
      || entry === null
      || !MIGRATION_NAME.test(entry.oldName ?? '')
      || !MIGRATION_NAME.test(entry.newName ?? '')
      || !CHECKSUM.test(entry.checksum ?? '')
      || entry.oldName === entry.newName
      || oldNames.has(entry.oldName)
      || newNames.has(entry.newName)
    ) {
      fail('the reviewed rename map is malformed');
    }
    oldNames.add(entry.oldName);
    newNames.add(entry.newName);
  }
}

function assertLocalMigrationChecksums(renameMap) {
  for (const { newName, checksum } of renameMap) {
    let bytes;
    try {
      bytes = readFileSync(
        new URL(`../prisma/migrations/${newName}/migration.sql`, import.meta.url),
      );
    } catch {
      fail(`the canonical migration file is missing: ${newName}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
      fail(`the canonical migration checksum mismatched: ${newName}`);
    }
  }
}

export function buildM1BStagingMigrationReconciliationSql(
  renameMap = M1B_STAGING_MIGRATION_RENAMES,
) {
  assertRenameMap(renameMap);
  const values = renameMap
    .map(({ oldName, newName, checksum }) => `  ('${oldName}', '${newName}', '${checksum}')`)
    .join(',\n');

  return `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE m1b_expected_database_identity (
  system_identifier text NOT NULL,
  database_oid oid NOT NULL,
  database_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO m1b_expected_database_identity (
  system_identifier,
  database_oid,
  database_name
) VALUES (
  :'expected_system_identifier',
  :'expected_database_oid'::oid,
  :'expected_database_name'
);

DO $m1b_identity$
DECLARE
  expected m1b_expected_database_identity%ROWTYPE;
  actual_system_identifier text;
  actual_database_oid oid;
  direct_role_is_global boolean;
BEGIN
  SELECT * INTO STRICT expected FROM m1b_expected_database_identity;
  SELECT control.system_identifier::text, database.oid
    INTO STRICT actual_system_identifier, actual_database_oid
    FROM pg_catalog.pg_control_system() AS control
    JOIN pg_catalog.pg_database AS database
      ON database.datname = pg_catalog.current_database();
  SELECT role.rolsuper OR role.rolbypassrls
    INTO STRICT direct_role_is_global
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = CURRENT_USER;

  IF actual_system_identifier <> expected.system_identifier
     OR actual_database_oid <> expected.database_oid
     OR pg_catalog.current_database() <> expected.database_name
     OR SESSION_USER <> 'postgres'
     OR CURRENT_USER <> 'postgres'
     OR NOT direct_role_is_global
     OR pg_catalog.pg_is_in_recovery()
     OR pg_catalog.current_setting('transaction_read_only') = 'on'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'm1b_staging_database_identity_mismatch';
  END IF;
END
$m1b_identity$;

SELECT pg_catalog.pg_advisory_xact_lock(72707369);
LOCK TABLE public."_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE m1b_migration_rename_map (
  old_name text PRIMARY KEY,
  new_name text NOT NULL UNIQUE,
  checksum text NOT NULL
) ON COMMIT DROP;

INSERT INTO m1b_migration_rename_map (old_name, new_name, checksum) VALUES
${values};

CREATE TEMP TABLE m1b_reconciliation_outcome (
  value text NOT NULL
) ON COMMIT PRESERVE ROWS;

DO $m1b_reconcile$
DECLARE
  old_total integer;
  old_distinct integer;
  old_valid integer;
  new_total integer;
  new_distinct integer;
  new_valid integer;
  updated integer;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM m1b_migration_rename_map) <> 11 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'm1b_staging_migration_map_mismatch';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT migration.migration_name)::integer,
    pg_catalog.count(*) FILTER (
      WHERE migration.checksum = mapping.checksum
        AND migration.finished_at IS NOT NULL
        AND migration.rolled_back_at IS NULL
        AND migration.applied_steps_count = 1
    )::integer
    INTO STRICT old_total, old_distinct, old_valid
    FROM public."_prisma_migrations" AS migration
    JOIN m1b_migration_rename_map AS mapping
      ON mapping.old_name = migration.migration_name;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT migration.migration_name)::integer,
    pg_catalog.count(*) FILTER (
      WHERE migration.checksum = mapping.checksum
        AND migration.finished_at IS NOT NULL
        AND migration.rolled_back_at IS NULL
        AND migration.applied_steps_count = 1
    )::integer
    INTO STRICT new_total, new_distinct, new_valid
    FROM public."_prisma_migrations" AS migration
    JOIN m1b_migration_rename_map AS mapping
      ON mapping.new_name = migration.migration_name;

  IF old_total = 11 AND old_distinct = 11 AND old_valid = 11 AND new_total = 0 THEN
    CREATE TEMP TABLE m1b_migration_snapshot ON COMMIT DROP AS
    SELECT
      migration.id,
      migration.checksum,
      migration.finished_at,
      migration.migration_name,
      migration.logs,
      migration.rolled_back_at,
      migration.started_at,
      migration.applied_steps_count
      FROM public."_prisma_migrations" AS migration
      JOIN m1b_migration_rename_map AS mapping
        ON mapping.old_name = migration.migration_name;

    UPDATE public."_prisma_migrations" AS migration
       SET migration_name = mapping.new_name
      FROM m1b_migration_rename_map AS mapping
     WHERE migration.migration_name = mapping.old_name
       AND migration.checksum = mapping.checksum
       AND migration.finished_at IS NOT NULL
       AND migration.rolled_back_at IS NULL
       AND migration.applied_steps_count = 1;
    GET DIAGNOSTICS updated = ROW_COUNT;

    IF updated <> 11 OR EXISTS (
      SELECT 1
        FROM m1b_migration_snapshot AS snapshot
        JOIN m1b_migration_rename_map AS mapping
          ON mapping.old_name = snapshot.migration_name
        LEFT JOIN public."_prisma_migrations" AS migration
          ON migration.id = snapshot.id
       WHERE migration.id IS NULL
          OR migration.migration_name <> mapping.new_name
          OR migration.checksum IS DISTINCT FROM snapshot.checksum
          OR migration.finished_at IS DISTINCT FROM snapshot.finished_at
          OR migration.logs IS DISTINCT FROM snapshot.logs
          OR migration.rolled_back_at IS DISTINCT FROM snapshot.rolled_back_at
          OR migration.started_at IS DISTINCT FROM snapshot.started_at
          OR migration.applied_steps_count IS DISTINCT FROM snapshot.applied_steps_count
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'm1b_staging_migration_metadata_changed';
    END IF;
    INSERT INTO m1b_reconciliation_outcome (value) VALUES ('reconciled:11');
  ELSIF old_total = 0
    AND new_total = 11
    AND new_distinct = 11
    AND new_valid = 11
  THEN
    INSERT INTO m1b_reconciliation_outcome (value) VALUES ('already-reconciled:11');
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'm1b_staging_migration_state_mismatch';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT migration.migration_name)::integer,
    pg_catalog.count(*) FILTER (
      WHERE migration.checksum = mapping.checksum
        AND migration.finished_at IS NOT NULL
        AND migration.rolled_back_at IS NULL
        AND migration.applied_steps_count = 1
    )::integer
    INTO STRICT new_total, new_distinct, new_valid
    FROM public."_prisma_migrations" AS migration
    JOIN m1b_migration_rename_map AS mapping
      ON mapping.new_name = migration.migration_name;

  IF EXISTS (
      SELECT 1
        FROM public."_prisma_migrations" AS migration
        JOIN m1b_migration_rename_map AS mapping
          ON mapping.old_name = migration.migration_name
    )
    OR new_total <> 11
    OR new_distinct <> 11
    OR new_valid <> 11
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'm1b_staging_migration_postcondition_failed';
  END IF;
END
$m1b_reconcile$;

COMMIT;
SELECT value FROM m1b_reconciliation_outcome;
`;
}

function decodeOutcome(stdout) {
  const rows = String(stdout).trim().split('\n').filter(Boolean);
  if (rows.length !== 1 || !RECONCILIATION_OUTCOME.test(rows[0])) {
    fail('the transaction returned an invalid outcome');
  }
  return rows[0];
}

export function reconcileM1BStagingMigrationNames(
  environment = process.env,
  dependencies = {},
) {
  const config = parseM1BStagingDatabaseEnvironment(environment);
  const spawn = dependencies.spawnSync ?? spawnSync;
  assertRenameMap(M1B_STAGING_MIGRATION_RENAMES);
  assertLocalMigrationChecksums(M1B_STAGING_MIGRATION_RENAMES);
  certifyM1BStagingDatabase(environment, { spawnSync: spawn });

  const sql = buildM1BStagingMigrationReconciliationSql();
  const result = withPsqlChildEnvironment(
    config.directUrl,
    environment,
    (childEnvironment) =>
      spawn(
        'psql',
        [
          '--no-psqlrc',
          '-X',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          `expected_system_identifier=${config.expectedSystemIdentifier}`,
          '-v',
          `expected_database_oid=${config.expectedDatabaseOid}`,
          '-v',
          `expected_database_name=${config.expectedDatabaseName}`,
        ],
        {
          input: sql,
          encoding: 'utf8',
          env: childEnvironment,
          timeout: 45_000,
        },
      ),
  );
  if (result.status !== 0) {
    fail('the transaction failed closed; inspect the bounded PostgreSQL job log');
  }
  return decodeOutcome(result.stdout);
}

function main() {
  const outcome = reconcileM1BStagingMigrationNames();
  process.stdout.write(`agent-mission-m1b-staging-migration-reconcile:ok:${outcome}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'agent-mission-m1b-staging-migration-reconcile:unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}
