import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDatabasePair,
  assertEphemeralSupabaseCiUrls,
  parseDatabaseIdentity,
} from './assert-database-pair.mjs';

const identity = Object.freeze({
  systemIdentifier: '7664442672552340354',
  databaseOid: 16_384,
  databaseName: 'bobpro',
  serverEncoding: 'UTF8',
  inRecovery: false,
  transactionReadOnly: false,
});

test('accepte deux rôles connectés à la même base primaire UTF-8', () => {
  assert.deepEqual(assertDatabasePair({ direct: identity, runtime: { ...identity } }), {
    systemIdentifier: identity.systemIdentifier,
    databaseOid: identity.databaseOid,
    databaseName: identity.databaseName,
  });
});

test('refuse deux clusters ou deux bases portant éventuellement le même nom', () => {
  assert.throws(
    () => assertDatabasePair({
      direct: identity,
      runtime: { ...identity, systemIdentifier: '8664442672552340354' },
    }),
    /database_connection_identity_mismatch:systemIdentifier/u,
  );
  assert.throws(
    () => assertDatabasePair({
      direct: identity,
      runtime: { ...identity, databaseOid: 16_385 },
    }),
    /database_connection_identity_mismatch:databaseOid/u,
  );
});

test('refuse un encodage non UTF-8 et toute connexion secondaire ou read-only', () => {
  assert.throws(
    () => assertDatabasePair({ direct: { ...identity, serverEncoding: 'LATIN1' }, runtime: identity }),
    /database_encoding_must_be_utf8:DIRECT_URL/u,
  );
  assert.throws(
    () => assertDatabasePair({ direct: identity, runtime: { ...identity, inRecovery: true } }),
    /database_connection_must_be_writable_primary:DATABASE_URL/u,
  );
  assert.throws(
    () => assertDatabasePair({
      direct: identity,
      runtime: { ...identity, transactionReadOnly: true },
    }),
    /database_connection_must_be_writable_primary:DATABASE_URL/u,
  );
});

test('parse fail-closed toute sortie psql absente ou mal formée', () => {
  assert.deepEqual(parseDatabaseIdentity(JSON.stringify(identity), 'test'), identity);
  for (const raw of ['', '{}', '{not-json}', JSON.stringify({ ...identity, databaseOid: 0 })]) {
    assert.throws(() => parseDatabaseIdentity(raw, 'test'), /database_identity_/u);
  }
});

const ownerSplitEnvironment = Object.freeze({
  DIRECT_URL: 'postgresql://postgres:postgres@localhost:5432/bob_ephemeral_ci',
  DATABASE_URL: 'postgresql://bob_app:bob_app@localhost:5432/bob_ephemeral_ci',
});

test('borne le owner-split aux deux identités exactes de la base CI loopback', () => {
  assert.deepEqual(
    assertEphemeralSupabaseCiUrls({
      mode: 'owner-split',
      environment: ownerSplitEnvironment,
    }),
    {
      databaseName: 'bob_ephemeral_ci',
      endpoint: 'localhost:5432',
    },
  );
  assert.deepEqual(
    assertEphemeralSupabaseCiUrls({
      mode: 'bootstrap',
      environment: {
        ...ownerSplitEnvironment,
        CI_POSTGRES_SUPER_URL:
          'postgresql://postgres:postgres@localhost:5432/bob_ephemeral_ci',
        CI_POSTGRES_ADMIN_URL:
          'postgresql://bob_ci_supabase_admin:bob_ci_supabase_admin@localhost:5432/bob_ephemeral_ci',
      },
    }),
    {
      databaseName: 'bob_ephemeral_ci',
      endpoint: 'localhost:5432',
    },
  );
});

test('refuse toute cible owner-split distante, paramétrée, implicite ou hors allowlist', () => {
  const invalidDirectUrls = [
    'postgresql://postgres:postgres@db.example.test:5432/bob_ephemeral_ci',
    'postgresql://postgres:postgres@localhost/bob_ephemeral_ci',
    'postgresql://postgres:postgres@localhost:5432/bob_ephemeral_ci?sslmode=disable',
    'postgresql://postgres:postgres@localhost:5432/bobpro',
    'postgresql://other:postgres@localhost:5432/bob_ephemeral_ci',
  ];
  for (const DIRECT_URL of invalidDirectUrls) {
    assert.throws(
      () => assertEphemeralSupabaseCiUrls({
        mode: 'owner-split',
        environment: { ...ownerSplitEnvironment, DIRECT_URL },
      }),
      /ephemeral_database_/u,
    );
  }
});

test('refuse le runtime incorrect et deux URI loopback visant des cibles différentes', () => {
  for (const DATABASE_URL of [
    'postgresql://bob_app:wrong@localhost:5432/bob_ephemeral_ci',
    'postgresql://bob_app:bob_app@127.0.0.1:5432/bob_ephemeral_ci',
    'postgresql://bob_app:bob_app@localhost:55432/bob_ephemeral_ci',
  ]) {
    assert.throws(
      () => assertEphemeralSupabaseCiUrls({
        mode: 'owner-split',
        environment: { ...ownerSplitEnvironment, DATABASE_URL },
      }),
      /ephemeral_database_/u,
    );
  }
  assert.throws(
    () => assertEphemeralSupabaseCiUrls({
      mode: 'owner-split',
      environment: { DIRECT_URL: ownerSplitEnvironment.DIRECT_URL },
    }),
    /ephemeral_database_url_required:DATABASE_URL/u,
  );
});

test('refuse tout mode de harnais inconnu', () => {
  assert.throws(
    () => assertEphemeralSupabaseCiUrls({
      mode: 'production',
      environment: ownerSplitEnvironment,
    }),
    /ephemeral_database_mode_must_be_bootstrap_or_owner_split/u,
  );
});
