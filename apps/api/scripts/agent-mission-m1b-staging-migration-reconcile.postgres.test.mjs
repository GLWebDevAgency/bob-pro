import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildM1BStagingMigrationReconciliationSql,
  M1B_STAGING_MIGRATION_RENAMES,
} from './agent-mission-m1b-staging-migration-reconcile.mjs';
import { withPsqlChildEnvironment } from './psql-child-environment.mjs';

const RUN_CERTIFICATE =
  process.env.RUN_AGENT_MISSION_M1B_MIGRATION_RECONCILIATION_CERT === 'true';
const CONNECTION_URL = process.env.AGENT_MISSION_CERT_SUPER_URL;
const PSQL = process.env.PSQL_BIN || 'psql';

function psql(sql, variables = {}) {
  assert.ok(CONNECTION_URL, 'AGENT_MISSION_CERT_SUPER_URL is required');
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) {
    args.push('-v', `${name}=${value}`);
  }
  return withPsqlChildEnvironment(CONNECTION_URL, process.env, (childEnvironment) =>
    spawnSync(PSQL, args, {
      input: sql,
      encoding: 'utf8',
      env: childEnvironment,
      timeout: 45_000,
    }),
  );
}

function mustSucceed(sql, variables = {}) {
  const result = psql(sql, variables);
  assert.equal(
    result.status,
    0,
    `PostgreSQL certificate command failed: ${String(result.stderr).trim().slice(0, 300)}`,
  );
  return String(result.stdout).trim();
}

function sqlLiteral(value) {
  assert.match(value, /^[a-z0-9_:-]+$/u);
  return `'${value}'`;
}

function insertRows(rows) {
  mustSucceed('TRUNCATE TABLE public."_prisma_migrations";');
  if (rows.length === 0) return;
  const values = rows.map((row, index) => {
    const finishedAt = row.unfinished ? 'NULL' : "'2026-07-27T03:00:00Z'::timestamptz";
    const rolledBackAt = row.rolledBack
      ? "'2026-07-27T03:05:00Z'::timestamptz"
      : 'NULL';
    return `(
      ${sqlLiteral(`m1b-cert-${String(index).padStart(2, '0')}`)},
      ${sqlLiteral(row.checksum)},
      ${finishedAt},
      ${sqlLiteral(row.name)},
      ${sqlLiteral(`log-${String(index).padStart(2, '0')}`)},
      ${rolledBackAt},
      '2026-07-27T02:59:00Z'::timestamptz,
      ${row.appliedSteps ?? 1}
    )`;
  });
  mustSucceed(`
INSERT INTO public."_prisma_migrations" (
  id,
  checksum,
  finished_at,
  migration_name,
  logs,
  rolled_back_at,
  started_at,
  applied_steps_count
) VALUES
${values.join(',\n')};
`);
}

function oldRows() {
  return M1B_STAGING_MIGRATION_RENAMES.map(({ oldName, checksum }) => ({
    name: oldName,
    checksum,
  }));
}

function newRows() {
  return M1B_STAGING_MIGRATION_RENAMES.map(({ newName, checksum }) => ({
    name: newName,
    checksum,
  }));
}

function databaseIdentity() {
  const raw = mustSucceed(`
SELECT control.system_identifier::text
       || '|' || database.oid::bigint::text
       || '|' || pg_catalog.current_database()
  FROM pg_catalog.pg_control_system() AS control
  JOIN pg_catalog.pg_database AS database
    ON database.datname = pg_catalog.current_database();
`);
  const [systemIdentifier, databaseOid, databaseName, ...unexpected] = raw.split('|');
  assert.equal(unexpected.length, 0);
  assert.match(systemIdentifier, /^[1-9][0-9]{0,29}$/u);
  assert.match(databaseOid, /^[1-9][0-9]{0,9}$/u);
  assert.match(databaseName, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u);
  return { systemIdentifier, databaseOid, databaseName };
}

function reconcile(identity, { readOnly = false } = {}) {
  const sql = `${readOnly ? 'SET default_transaction_read_only = on;\n' : ''}${
    buildM1BStagingMigrationReconciliationSql()
  }`;
  return psql(sql, {
    expected_system_identifier: identity.systemIdentifier,
    expected_database_oid: identity.databaseOid,
    expected_database_name: identity.databaseName,
  });
}

function snapshot() {
  return mustSucceed(`
SELECT id
       || '|' || migration_name
       || '|' || checksum
       || '|' || COALESCE(finished_at::text, 'null')
       || '|' || COALESCE(rolled_back_at::text, 'null')
       || '|' || started_at::text
       || '|' || applied_steps_count::text
       || '|' || COALESCE(logs, 'null')
  FROM public."_prisma_migrations"
 ORDER BY id;
`);
}

function assertRejectedWithoutMutation(identity, rows, options = {}) {
  insertRows(rows);
  const before = snapshot();
  const result = reconcile(identity, options);
  assert.notEqual(result.status, 0);
  assert.equal(snapshot(), before);
}

test(
  'réconciliation M1-B — certificat PostgreSQL réel, idempotence et rollback',
  { skip: !RUN_CERTIFICATE },
  () => {
    assert.ok(CONNECTION_URL, 'AGENT_MISSION_CERT_SUPER_URL is required');
    const preexisting = mustSucceed(
      `SELECT pg_catalog.to_regclass('public."_prisma_migrations"') IS NOT NULL;`,
    );
    assert.equal(preexisting, 'f', 'the disposable certificate database must start empty');

    mustSucceed(`
CREATE TABLE public."_prisma_migrations" (
  id varchar(36) PRIMARY KEY,
  checksum varchar(64) NOT NULL,
  finished_at timestamptz,
  migration_name varchar(255) NOT NULL,
  logs text,
  rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  applied_steps_count integer NOT NULL DEFAULT 0
);
`);

    try {
      const identity = databaseIdentity();

      insertRows(oldRows());
      const before = snapshot();
      const renamed = reconcile(identity);
      assert.equal(renamed.status, 0);
      assert.equal(String(renamed.stdout).trim(), 'reconciled:11');
      const after = snapshot();
      for (const { oldName, newName } of M1B_STAGING_MIGRATION_RENAMES) {
        assert.equal(after.includes(oldName), false);
        assert.equal(after.includes(newName), true);
      }
      assert.equal(
        after
          .split('\n')
          .map((row) => row.split('|').toSpliced(1, 1).join('|'))
          .join('\n'),
        before
          .split('\n')
          .map((row) => row.split('|').toSpliced(1, 1).join('|'))
          .join('\n'),
      );

      const replay = reconcile(identity);
      assert.equal(replay.status, 0);
      assert.equal(String(replay.stdout).trim(), 'already-reconciled:11');
      assert.equal(snapshot(), after, 'an ACK-loss replay must be a strict no-op');

      const mixed = oldRows();
      mixed[10] = newRows()[10];
      assertRejectedWithoutMutation(identity, mixed);
      assertRejectedWithoutMutation(identity, oldRows().slice(0, 10));
      assertRejectedWithoutMutation(identity, [...oldRows(), oldRows()[0]]);

      const wrongChecksum = oldRows();
      wrongChecksum[3] = { ...wrongChecksum[3], checksum: '0'.repeat(64) };
      assertRejectedWithoutMutation(identity, wrongChecksum);

      const unfinished = oldRows();
      unfinished[4] = { ...unfinished[4], unfinished: true };
      assertRejectedWithoutMutation(identity, unfinished);

      const rolledBack = oldRows();
      rolledBack[5] = { ...rolledBack[5], rolledBack: true };
      assertRejectedWithoutMutation(identity, rolledBack);

      assertRejectedWithoutMutation(
        { ...identity, systemIdentifier: String(BigInt(identity.systemIdentifier) + 1n) },
        oldRows(),
      );
      assertRejectedWithoutMutation(identity, oldRows(), { readOnly: true });
    } finally {
      mustSucceed('DROP TABLE public."_prisma_migrations";');
    }
  },
);
