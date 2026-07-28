import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildM1BStagingMigrationReconciliationSql,
  M1B_STAGING_MIGRATION_RENAMES,
  reconcileM1BStagingMigrationNames,
} from './agent-mission-m1b-staging-migration-reconcile.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const SYSTEM_IDENTIFIER = '7390123456789012345';
const DATABASE_OID = 16_384;
const APP_ROLE = 'bob_app';
const repositoryRoot = resolve(import.meta.dirname, '../../..');

function environment(overrides = {}) {
  return {
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: PROJECT_REF,
    BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER: SYSTEM_IDENTIFIER,
    BOB_M1B_STAGING_DATABASE_OID: String(DATABASE_OID),
    BOB_M1B_STAGING_DATABASE_NAME: 'postgres',
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    DIRECT_URL:
      `postgresql://postgres.${PROJECT_REF}:sensitive-password@pooler.supabase.com:5432/postgres`,
    DATABASE_URL:
      `postgresql://${APP_ROLE}.${PROJECT_REF}:sensitive-password@pooler.supabase.com:5432/postgres`,
    APP_DATABASE_ROLE: APP_ROLE,
    ...overrides,
  };
}

function identity(direct) {
  return JSON.stringify({
    systemIdentifier: SYSTEM_IDENTIFIER,
    databaseOid: DATABASE_OID,
    databaseName: 'postgres',
    serverEncoding: 'UTF8',
    inRecovery: false,
    transactionReadOnly: false,
    sessionUser: direct ? 'postgres' : APP_ROLE,
    currentUser: direct ? 'postgres' : APP_ROLE,
    roleSuperuser: false,
    roleBypassRls: direct,
  });
}

function successfulSpawn(outcome = 'renamed') {
  const calls = [];
  return {
    calls,
    spawnSync: (command, args, options) => {
      assert.equal(command, 'psql');
      assert.equal(existsSync(options.env.PGPASSFILE), true);
      calls.push({ args, options });
      if (calls.length <= 2) {
        return {
          status: 0,
          stdout: `${identity(calls.length === 1)}\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: `${outcome}\n`, stderr: '' };
    },
  };
}

test('la table revue couvre exactement les onze renommages et les octets locaux', () => {
  assert.equal(M1B_STAGING_MIGRATION_RENAMES.length, 11);
  assert.equal(new Set(M1B_STAGING_MIGRATION_RENAMES.map(({ oldName }) => oldName)).size, 11);
  assert.equal(new Set(M1B_STAGING_MIGRATION_RENAMES.map(({ newName }) => newName)).size, 11);
  for (const entry of M1B_STAGING_MIGRATION_RENAMES) {
    assert.ok(entry.oldName < entry.newName);
    const bytes = readFileSync(
      resolve(repositoryRoot, `apps/api/prisma/migrations/${entry.newName}/migration.sql`),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.checksum);
  }
});

test('la transaction épingle la base, verrouille Prisma et ne change que migration_name', () => {
  const sql = buildM1BStagingMigrationReconciliationSql();
  assert.match(sql, /\bBEGIN;/u);
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/u);
  assert.match(sql, /SET LOCAL statement_timeout = '30s'/u);
  assert.match(
    sql,
    /LOCK TABLE public\."_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE/u,
  );
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock\(72707369\)/u);
  assert.match(sql, /pg_catalog\.pg_control_system\(\)/u);
  assert.match(sql, /actual_system_identifier <> expected\.system_identifier/u);
  assert.match(sql, /actual_database_oid <> expected\.database_oid/u);
  assert.match(sql, /SESSION_USER <> 'postgres'/u);
  assert.match(sql, /migration\.checksum = mapping\.checksum/u);
  assert.match(sql, /migration\.finished_at IS NOT NULL/u);
  assert.match(sql, /migration\.rolled_back_at IS NULL/u);
  assert.match(sql, /migration\.applied_steps_count = 1/u);
  assert.match(
    sql,
    /UPDATE public\."_prisma_migrations" AS migration\s+SET migration_name = mapping\.new_name/u,
  );
  assert.doesNotMatch(sql, /DELETE\s+FROM public\."_prisma_migrations"/iu);
  assert.doesNotMatch(sql, /INSERT\s+INTO public\."_prisma_migrations"/iu);
  assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|FUNCTION|TYPE)\s+public\./iu);
  assert.ok(sql.indexOf('COMMIT;') < sql.indexOf('SELECT value FROM m1b_reconciliation_outcome'));
});

for (const outcome of ['reconciled:11', 'already-reconciled:11']) {
  test(`l'opérateur accepte uniquement le verdict transactionnel ${outcome}`, () => {
    const fake = successfulSpawn(outcome);
    assert.equal(
      reconcileM1BStagingMigrationNames(environment(), { spawnSync: fake.spawnSync }),
      outcome,
    );
    assert.equal(fake.calls.length, 3);
    const transaction = fake.calls[2];
    assert.equal(transaction.args.includes(environment().DIRECT_URL), false);
    assert.equal(transaction.args.some((value) => String(value).includes('sensitive-password')), false);
    assert.equal(transaction.options.env.PGUSER, `postgres.${PROJECT_REF}`);
    assert.equal(Object.hasOwn(transaction.options.env, 'PGPASSWORD'), false);
    assert.equal(existsSync(transaction.options.env.PGPASSFILE), false);
    assert.match(transaction.options.input, /m1b_staging_migration_state_mismatch/u);
    assert.deepEqual(
      transaction.args.filter((value) => String(value).startsWith('expected_')),
      [
        `expected_system_identifier=${SYSTEM_IDENTIFIER}`,
        `expected_database_oid=${DATABASE_OID}`,
        'expected_database_name=postgres',
      ],
    );
  });
}

test('un état SQL inattendu échoue fermé sans exposer la connexion', () => {
  const fake = successfulSpawn('reconciled:11');
  fake.spawnSync = (command, args, options) => {
    const call = fake.calls.length + 1;
    if (call <= 2) {
      fake.calls.push({ args, options });
      return { status: 0, stdout: `${identity(call === 1)}\n`, stderr: '' };
    }
    fake.calls.push({ args, options });
    return {
      status: 1,
      stdout: '',
      stderr: `fatal ${environment().DIRECT_URL} sensitive-password`,
    };
  };
  assert.throws(
    () => reconcileM1BStagingMigrationNames(environment(), { spawnSync: fake.spawnSync }),
    (error) => {
      assert.match(error.message, /transaction failed closed/u);
      assert.doesNotMatch(error.message, /sensitive-password|postgresql:/u);
      return true;
    },
  );
});

test('un résultat ambigu est refusé même après une transaction déclarée réussie', () => {
  const fake = successfulSpawn('reconciled:11\nalready-reconciled:11');
  assert.throws(
    () => reconcileM1BStagingMigrationNames(environment(), { spawnSync: fake.spawnSync }),
    /invalid outcome/u,
  );
});
