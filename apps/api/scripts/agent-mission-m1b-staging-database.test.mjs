import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertM1BStagingDatabaseIdentity,
  certifyM1BStagingDatabase,
  decodeM1BStagingDatabaseIdentity,
  parseM1BStagingDatabaseEnvironment,
} from './agent-mission-m1b-staging-database.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const SYSTEM_IDENTIFIER = '7390123456789012345';
const DATABASE_OID = 16_384;
const APP_ROLE = 'bob_app';

function environment(overrides = {}) {
  return {
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: PROJECT_REF,
    BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER: SYSTEM_IDENTIFIER,
    BOB_M1B_STAGING_DATABASE_OID: String(DATABASE_OID),
    BOB_M1B_STAGING_DATABASE_NAME: 'postgres',
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    DIRECT_URL:
      `postgresql://postgres.${PROJECT_REF}:secret@pooler.supabase.com:5432/postgres`,
    DATABASE_URL:
      `postgresql://${APP_ROLE}.${PROJECT_REF}:secret@pooler.supabase.com:5432/postgres`,
    APP_DATABASE_ROLE: APP_ROLE,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    systemIdentifier: SYSTEM_IDENTIFIER,
    databaseOid: DATABASE_OID,
    databaseName: 'postgres',
    serverEncoding: 'UTF8',
    inRecovery: false,
    transactionReadOnly: false,
    sessionUser: APP_ROLE,
    currentUser: APP_ROLE,
    roleSuperuser: false,
    roleBypassRls: false,
    ...overrides,
  };
}

test('parse épingle le project ref et les deux rôles Supabase exacts', () => {
  const parsed = parseM1BStagingDatabaseEnvironment(environment());
  assert.equal(parsed.projectRef, PROJECT_REF);
  assert.equal(parsed.expectedDatabaseOid, DATABASE_OID);
  assert.throws(
    () => parseM1BStagingDatabaseEnvironment(environment({
      SUPABASE_URL: 'https://foreignprojectrefxx.supabase.co',
    })),
    /pinned staging project/u,
  );
  assert.throws(
    () => parseM1BStagingDatabaseEnvironment(environment({
      DATABASE_URL:
        'postgresql://bob_app.foreignprojectrefxx:secret@pooler.supabase.com/postgres',
    })),
    /pinned Supabase project/u,
  );
});

test('décode uniquement une primaire PostgreSQL UTF8 inscriptible', () => {
  assert.deepEqual(
    decodeM1BStagingDatabaseIdentity(JSON.stringify(identity()), 'DATABASE_URL'),
    identity(),
  );
  assert.throws(
    () => decodeM1BStagingDatabaseIdentity(
      JSON.stringify(identity({ transactionReadOnly: true })),
      'DATABASE_URL',
    ),
    /writable primary/u,
  );
  assert.throws(
    () => decodeM1BStagingDatabaseIdentity(
      JSON.stringify(identity({ serverEncoding: 'LATIN1' })),
      'DATABASE_URL',
    ),
    /malformed/u,
  );
});

test('preuve croise cluster, base, migration role et runtime RLS exacts', () => {
  const config = parseM1BStagingDatabaseEnvironment(environment());
  const direct = identity({
    sessionUser: 'postgres',
    currentUser: 'postgres',
    roleBypassRls: true,
  });
  const runtime = identity();
  assert.deepEqual(
    assertM1BStagingDatabaseIdentity(config, direct, runtime),
    {
      systemIdentifier: SYSTEM_IDENTIFIER,
      databaseOid: DATABASE_OID,
      databaseName: 'postgres',
    },
  );
  assert.throws(
    () => assertM1BStagingDatabaseIdentity(
      config,
      direct,
      identity({ databaseOid: DATABASE_OID + 1 }),
    ),
    /databaseOid/u,
  );
  assert.throws(
    () => assertM1BStagingDatabaseIdentity(
      config,
      direct,
      identity({ roleBypassRls: true }),
    ),
    /restricted runtime role/u,
  );
});

test('certification interroge DIRECT puis runtime sans imprimer les URLs', () => {
  const calls = [];
  const result = certifyM1BStagingDatabase(environment(), {
    spawnSync: (_command, args, options) => {
      calls.push({ args, options });
      const url = args.at(-1);
      const direct = url === environment().DIRECT_URL;
      return {
        status: 0,
        stdout: `${JSON.stringify(identity(direct ? {
          sessionUser: 'postgres',
          currentUser: 'postgres',
          roleBypassRls: true,
        } : {}))}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.databaseName, 'postgres');
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.input, /pg_control_system/u);
  assert.equal(calls[0].options.input.includes(PROJECT_REF), false);
  assert.equal(calls[0].options.input.includes('secret'), false);
});
