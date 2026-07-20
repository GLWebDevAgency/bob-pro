import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addedMigrationNamesFromPaths,
  assertBaseMigrationFilesImmutable,
  assertMigrationLineage,
} from './assert-migration-lineage.mjs';

const baseNames = [
  '20260720030000_situation_order_unique_backstop',
  '20260720190000_credit_note_inherits_vat_treatment',
  '20260720210000_voice_trace_beta',
];

test('accepte des préfixes nouveaux, strictement postérieurs et uniques', () => {
  assert.deepEqual(assertMigrationLineage({
    baseNames,
    addedNames: [
      '20260720220000_mistral_conversation_terminal_cursor_hardening',
      '20260720230000_realtime_native_speech_delivery',
    ],
  }), {
    baseMaximum: '20260720210000',
    added: [
      '20260720220000_mistral_conversation_terminal_cursor_hardening',
      '20260720230000_realtime_native_speech_delivery',
    ],
  });
});

test('tolère les collisions historiques de la branche cible sans les propager', () => {
  assert.doesNotThrow(() => assertMigrationLineage({ baseNames, addedNames: [] }));
});

test('refuse un ajout antidaté ou égal au dernier préfixe de la branche cible', () => {
  for (const name of [
    '20260720160000_realtime_native_speech_delivery',
    '20260720210000_realtime_native_speech_delivery',
  ]) {
    assert.throws(
      () => assertMigrationLineage({ baseNames, addedNames: [name] }),
      /migration_prefix_not_after_base/u,
    );
  }
});

test('refuse deux migrations nouvelles portant le même préfixe', () => {
  assert.throws(
    () => assertMigrationLineage({
      baseNames,
      addedNames: [
        '20260720220000_realtime_native_speech_delivery',
        '20260720220000_other_lane',
      ],
    }),
    /duplicate_new_migration_prefix/u,
  );
});

test('refuse les noms non canoniques et une base vide', () => {
  assert.throws(
    () => assertMigrationLineage({ baseNames, addedNames: ['migration_without_timestamp'] }),
    /invalid_migration_name/u,
  );
  assert.throws(
    () => assertMigrationLineage({ baseNames: [], addedNames: [] }),
    /migration_base_is_empty/u,
  );
});

test('inclut les migrations commitées, indexées et non suivies avant le commit', () => {
  const first = 'apps/api/prisma/migrations/20260720220000_terminal_cursor/migration.sql';
  const second = 'apps/api/prisma/migrations/20260720230000_native_delivery/migration.sql';
  const third = 'apps/api/prisma/migrations/20260720240000_cost_dimensions/migration.sql';
  assert.deepEqual(addedMigrationNamesFromPaths({
    committedPaths: [first],
    stagedPaths: [first, second],
    untrackedPaths: [third],
  }), [
    '20260720220000_terminal_cursor',
    '20260720230000_native_delivery',
    '20260720240000_cost_dimensions',
  ]);
  assert.throws(
    () => addedMigrationNamesFromPaths({
      committedPaths: [],
      stagedPaths: [],
      untrackedPaths: ['apps/api/prisma/migrations/not-canonical/migration.sql'],
    }),
    /invalid_migration_path/u,
  );
});

test('refuse toute mutation, suppression ou renommage d’une migration de la branche cible', () => {
  assert.doesNotThrow(() => assertBaseMigrationFilesImmutable([
    'A\tapps/api/prisma/migrations/20260720220000_native_delivery/migration.sql',
  ]));
  for (const change of [
    'M\tapps/api/prisma/migrations/20260719160000_legal/migration.sql',
    'D\tapps/api/prisma/migrations/20260719160000_legal/migration.sql',
    [
      'R100',
      'apps/api/prisma/migrations/20260719160000_legal/migration.sql',
      'apps/api/prisma/migrations/20260720220000_renamed/migration.sql',
    ].join('\t'),
    'T\tapps/api/prisma/migrations/20260719160000_legal/migration.sql',
  ]) {
    assert.throws(
      () => assertBaseMigrationFilesImmutable([change]),
      /existing_migration_changed/u,
    );
  }
  assert.throws(
    () => assertBaseMigrationFilesImmutable(['malformed']),
    /invalid_migration_change/u,
  );
});

test('tolère les quatre collisions HISTORIQUES déjà appliquées, mais jamais une nouvelle', () => {
  // Ces dossiers existent en production ; les renommer casserait _prisma_migrations, qui est
  // clé sur le nom complet. La garde les CONSTATE au lieu de bloquer la remise à niveau de main.
  const historiques = [
    '20260717150000_chantier_notes_photos',
    '20260717150000_company_billing_settings',
    '20260718110000_mistral_conversation_replay_grace',
    '20260718110000_mistral_conversation_resume_tickets',
  ];
  assert.doesNotThrow(() =>
    assertMigrationLineage({ baseNames: ['20260101000000_base'], addedNames: historiques }),
  );

  // Une NOUVELLE collision, elle, reste refusée — y compris sur un préfixe historique réutilisé
  // sous un autre nom : l'exception est nominative, pas par préfixe.
  assert.throws(
    () =>
      assertMigrationLineage({
        baseNames: ['20260101000000_base'],
        addedNames: ['20260717150000_chantier_notes_photos', '20260717150000_autre_chantier'],
      }),
    /duplicate_new_migration_prefix:20260717150000/u,
  );
  assert.throws(
    () =>
      assertMigrationLineage({
        baseNames: ['20260101000000_base'],
        addedNames: ['20260722000000_alpha', '20260722000000_beta'],
      }),
    /duplicate_new_migration_prefix:20260722000000/u,
  );
});
