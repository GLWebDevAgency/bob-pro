import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDatabasePair, parseDatabaseIdentity } from './assert-database-pair.mjs';

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
