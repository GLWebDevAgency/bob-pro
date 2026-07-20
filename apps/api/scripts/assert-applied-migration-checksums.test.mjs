import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAppliedMigrationChecksums,
  parseAppliedMigrationRows,
} from './assert-applied-migration-checksums.mjs';

const first = '20260720210000_voice_trace_beta';
const second = '20260720220000_terminal_cursor';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

test('postflight exige la bijection exacte entre fichiers et migrations terminées', () => {
  const applied = parseAppliedMigrationRows(`${first}|${hashA}\n${second}|${hashB}\n`);
  assert.deepEqual(assertAppliedMigrationChecksums({
    applied,
    local: new Map([[first, hashA], [second, hashB]]),
  }), { appliedCount: 2, pendingCount: 0 });
});

test('preflight tolère seulement les migrations locales encore en attente', () => {
  assert.deepEqual(assertAppliedMigrationChecksums({
    applied: [{ name: first, checksum: hashA }],
    local: new Map([[first, hashA], [second, hashB]]),
    allowPendingLocal: true,
  }), { appliedCount: 1, pendingCount: 1 });
  assert.deepEqual(assertAppliedMigrationChecksums({
    applied: [],
    local: new Map([[first, hashA]]),
    allowPendingLocal: true,
  }), { appliedCount: 0, pendingCount: 1 });
});

test('refuse toute migration appliquée divergente ou absente, même en preflight', () => {
  for (const options of [
    {
      applied: [{ name: first, checksum: hashA }],
      local: new Map([[first, hashB]]),
      expected: /migration_checksum_mismatch/u,
    },
    {
      applied: [{ name: first, checksum: hashA }],
      local: new Map([[second, hashB]]),
      expected: /applied_migration_file_missing/u,
    },
  ]) {
    assert.throws(
      () => assertAppliedMigrationChecksums({ ...options, allowPendingLocal: true }),
      options.expected,
    );
  }
});

test('postflight refuse un fichier non appliqué et les jeux appliqués vides', () => {
  assert.throws(
    () => assertAppliedMigrationChecksums({
      applied: [{ name: first, checksum: hashA }],
      local: new Map([[first, hashA], [second, hashB]]),
    }),
    /migration_not_applied/u,
  );
  assert.throws(
    () => assertAppliedMigrationChecksums({ applied: [], local: new Map([[first, hashA]]) }),
    /applied_migration_set_is_empty/u,
  );
});

test('refuse doublons, jeu local vide et sorties SQL mal formées', () => {
  assert.throws(
    () => assertAppliedMigrationChecksums({
      applied: [{ name: first, checksum: hashA }, { name: first, checksum: hashA }],
      local: new Map([[first, hashA]]),
    }),
    /duplicate_applied_migration/u,
  );
  assert.throws(
    () => assertAppliedMigrationChecksums({ applied: [], local: new Map(), allowPendingLocal: true }),
    /local_migration_set_is_empty/u,
  );
  assert.throws(
    () => parseAppliedMigrationRows(`${first}|not-a-checksum`),
    /invalid_applied_migration_row/u,
  );
});
