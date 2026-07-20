import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  manageMistralConversationKeyVersion,
  parseMistralKeyVersionOperation,
} from './manage-mistral-conversation-key-version.mjs';

function enabled(version = '3', additionalVersions = []) {
  const canonicalVersion = /^[1-9][0-9]*$/.test(version) ? version : '1';
  const keyring = Object.fromEntries(
    [...new Set([canonicalVersion, ...additionalVersions])].map((keyVersion) => [
      keyVersion,
      Buffer.alloc(32, Number(keyVersion) % 255).toString('base64url'),
    ]),
  );
  return {
    BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED: 'true',
    BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION: version,
    BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING: JSON.stringify(keyring),
    BOB_LIVE_SUBJECT_KEY_VERSION: '1',
    BOB_LIVE_SUBJECT_HMAC_SECRET: subjectSecret('1'),
    BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({ 1: subjectSecret('1') }),
    DIRECT_URL: 'postgresql://admin.invalid/bob',
  };
}

function fingerprint(version) {
  return createHash('sha256')
    .update(Buffer.alloc(32, Number(version) % 255))
    .digest('hex');
}

function identityFingerprint(version) {
  return createHash('sha256')
    .update(Buffer.alloc(32, (Number(version) + 100) % 255))
    .digest('hex');
}

function subjectSecret(version) {
  return `legacy-subject-hmac-version-${version}-2026`.padEnd(40, 'x');
}

function subjectFingerprint(version) {
  return createHash('sha256').update(subjectSecret(version), 'utf8').digest('hex');
}

function withSubject(environment, version = '2', additionalVersions = []) {
  const keyring = Object.fromEntries(
    [...new Set([version, ...additionalVersions])].map((keyVersion) => [
      keyVersion,
      subjectSecret(keyVersion),
    ]),
  );
  return {
    ...environment,
    BOB_LIVE_SUBJECT_KEY_VERSION: version,
    BOB_LIVE_SUBJECT_HMAC_SECRET: keyring[version],
    BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify(keyring),
  };
}

function withIdentity(environment, version = '8', additionalVersions = []) {
  const keyring = Object.fromEntries(
    [...new Set([version, ...additionalVersions])].map((keyVersion) => [
      keyVersion,
      Buffer.alloc(32, (Number(keyVersion) + 100) % 255).toString('base64url'),
    ]),
  );
  return {
    ...environment,
    BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION: version,
    BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING: JSON.stringify(keyring),
  };
}

function prismaReturning(
  range,
  {
    retained = [],
    retainedReconciliation = [],
    retainedIdentity = [],
    retainedSubject = [],
    existingRange = null,
    existingIdentityRange = null,
    existingSubjectRange = null,
    identityResultRange = null,
    subjectResultRange = { minimumVersion: 1, highestVersion: 1 },
    mismatchedBindingVersion = null,
    mismatchedIdentityBindingVersion = null,
    mismatchedSubjectBindingVersion = null,
  } = {},
) {
  let queryCount = 0;
  const executions = [];
  return {
    queryCount: () => queryCount,
    executions: () => [...executions],
    $transaction: async (callback) => callback({
      $executeRaw: async (strings, ...values) => {
        queryCount += 1;
        executions.push({ sql: strings.join('?'), values });
        return 1;
      },
      $queryRaw: async (strings, ...values) => {
        queryCount += 1;
        const sql = strings.join('?');
        if (sql.includes('retained_versions')) {
          return retained.map((version) => ({ version }));
        }
        if (sql.includes('retained_subject_versions')) {
          return retainedSubject.map((version) => ({ version }));
        }
        if (sql.includes('realtime_mistral_conversation_resume_tickets')) {
          return retainedReconciliation.map((version) => ({ version }));
        }
        if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
          return retainedIdentity.map((version) => ({ version }));
        }
        if (
          sql.includes('FROM realtime_mistral_conversation_key_version_floors')
          && sql.includes('SELECT "minimumVersion"')
        ) {
          if (values.includes('bob-live-subject-hmac-v1')) {
            return existingSubjectRange ? [existingSubjectRange] : [];
          }
          return existingRange ? [existingRange] : [];
        }
        if (
          sql.includes('FROM realtime_mistral_conversation_identity_key_version_floors')
          && sql.includes('SELECT "minimumVersion"')
        ) return existingIdentityRange ? [existingIdentityRange] : [];
        if (sql.includes('FROM realtime_mistral_conversation_identity_key_bindings')) {
          const version = Number(values.at(-1));
          return [{
            keyFingerprint: version === mismatchedIdentityBindingVersion
              ? 'f'.repeat(64)
              : identityFingerprint(version),
          }];
        }
        if (sql.includes('FROM realtime_mistral_conversation_key_bindings')) {
          const version = Number(values.at(-1));
          if (values.includes('bob-live-subject-hmac-v1')) {
            return [{
              keyFingerprint: version === mismatchedSubjectBindingVersion
                ? 'f'.repeat(64)
                : subjectFingerprint(version),
            }];
          }
          return [{
            keyFingerprint: version === mismatchedBindingVersion
              ? 'f'.repeat(64)
              : fingerprint(version),
          }];
        }
        if (
          sql.includes('realtime_mistral_conversation_identity_key_version_floors')
          && (sql.includes('INSERT INTO') || sql.includes('UPDATE'))
        ) return identityResultRange ? [identityResultRange] : [];
        if (
          sql.includes('realtime_mistral_conversation_key_version_floors')
          && values.includes('bob-live-subject-hmac-v1')
          && (sql.includes('INSERT INTO') || sql.includes('UPDATE'))
        ) return subjectResultRange ? [subjectResultRange] : [];
        return range ? [range] : [];
      },
    }),
  };
}

test('la rotation reste dormante sans opt-in', () => {
  assert.deepEqual(
    parseMistralKeyVersionOperation('stage', {}),
    { enabled: false, mode: 'stage' },
  );
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED: 'false',
      BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION: '1',
    }),
    /forbidden while terminal replay is disabled/,
  );
});

test('le contrat refuse modes, booléens et versions non canoniques', () => {
  assert.throws(() => parseMistralKeyVersionOperation('advance', enabled()), /mode/);
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...enabled(),
      BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED: 'yes',
    }),
    /must be true or false/,
  );
  for (const version of ['', '0', '01', '-1', '1.5', '2147483648']) {
    assert.throws(
      () => parseMistralKeyVersionOperation('stage', enabled(version)),
      /version|integer range/,
    );
  }
});

test('le keyring identité est complet, canonique et requis uniquement pour émettre', () => {
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...enabled(),
      BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED: 'true',
    }),
    /identity encryption key config is required while initial bootstrap is enabled/,
  );
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...enabled(),
      BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION: '8',
    }),
    /identity encryption key config must be complete/,
  );
  const secret = Buffer.alloc(32, 108).toString('base64url');
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...enabled(),
      BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION: '8',
      BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING: `{"08":"${secret}"}`,
    }),
    /identity encryption keyring contains an invalid version/,
  );
  const parsed = parseMistralKeyVersionOperation(
    'stage',
    withIdentity(enabled(), '8'),
  );
  assert.deepEqual(parsed.identityKeyBindings, [{
    version: 8,
    fingerprint: identityFingerprint(8),
  }]);
});

test('le keyring HMAC sujet préserve les secrets legacy octet pour octet', () => {
  const legacy = 'legacy-HMAC-secret-kept-byte-for-byte-2026';
  const parsed = parseMistralKeyVersionOperation('stage', {
    ...enabled(),
    BOB_LIVE_SUBJECT_HMAC_SECRET: legacy,
    BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({ 1: legacy }),
  });
  assert.deepEqual(parsed.subjectKeyBindings, [{
    version: 1,
    fingerprint: createHash('sha256').update(legacy, 'utf8').digest('hex'),
  }]);

  for (const invalid of [
    'x'.repeat(31),
    `subject${'x'.repeat(30)} secret`,
    `subject${'x'.repeat(30)}\nsecret`,
    `[subject-${'x'.repeat(32)}]`,
    `subject-é-${'x'.repeat(32)}`,
  ]) {
    assert.throws(
      () => parseMistralKeyVersionOperation('stage', {
        ...enabled(),
        BOB_LIVE_SUBJECT_HMAC_SECRET: invalid,
        BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({ 1: invalid }),
      }),
      /subject HMAC keyring contains an invalid secret/u,
    );
  }
});

test('le keyring sujet refuse absence, divergence, doublon et réemploi inter-domaines', () => {
  const base = enabled();
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...base,
      BOB_LIVE_SUBJECT_HMAC_KEYRING: undefined,
    }),
    /subject HMAC keyring size is invalid/u,
  );
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...withSubject(base, '2'),
      BOB_LIVE_SUBJECT_HMAC_SECRET: subjectSecret('1'),
    }),
    /legacy subject HMAC secret does not match/u,
  );
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...base,
      BOB_LIVE_SUBJECT_KEY_VERSION: '2',
    }),
    /does not contain current version/u,
  );
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...base,
      BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({
        1: subjectSecret('1'),
        2: subjectSecret('1'),
      }),
    }),
    /reuses key material/u,
  );
  const persistenceSecret = JSON.parse(base.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING)['3'];
  assert.throws(
    () => parseMistralKeyVersionOperation('stage', {
      ...base,
      BOB_LIVE_SUBJECT_HMAC_SECRET: persistenceSecret,
      BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({ 1: persistenceSecret }),
    }),
    /subject HMAC key material must be dedicated/u,
  );
});

test('stage prépare la clé sans retirer la version courante', async () => {
  const prisma = prismaReturning(
    { minimumVersion: 2, highestVersion: 3 },
    { existingRange: { minimumVersion: 2, highestVersion: 2 } },
  );
  const config = parseMistralKeyVersionOperation('stage', enabled('3', ['2']));
  assert.deepEqual(
    await manageMistralConversationKeyVersion(config, prisma),
    { status: 'staged', minimumVersion: 2, highestVersion: 3 },
  );
  assert.ok(prisma.queryCount() >= 8);
});

test('retire exige que le plancher atteigne exactement la version demandée', async () => {
  const config = parseMistralKeyVersionOperation('retire', enabled('3', ['2']));
  await assert.rejects(
    manageMistralConversationKeyVersion(
      config,
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        { existingRange: { minimumVersion: 2, highestVersion: 3 } },
      ),
    ),
    /retirement did not reach version 3/,
  );
  assert.deepEqual(
    await manageMistralConversationKeyVersion(
      config,
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        { existingRange: { minimumVersion: 2, highestVersion: 3 } },
      ),
    ),
    { status: 'retired', minimumVersion: 3, highestVersion: 3 },
  );
});

test('un rollback ou une ligne absente échoue fermé', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('2', ['3', '4'])),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 4 },
        { existingRange: { minimumVersion: 3, highestVersion: 4 } },
      ),
    ),
    /outside the durable range/,
  );
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('retire', enabled('3', ['2'])),
      prismaReturning(null, {
        existingRange: { minimumVersion: 2, highestVersion: 3 },
      }),
    ),
    /did not return one durable range/,
  );
});

test('la release refuse de perdre une clé encore référencée par la base', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3')),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          retained: [2],
          existingRange: { minimumVersion: 2, highestVersion: 2 },
        },
      ),
    ),
    /does not cover every admitted or retained persistence version/,
  );
});

test('retire refuse une ancienne clé référencée par toute réconciliation non purgée', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('retire', enabled('3', ['2'])),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedReconciliation: [2],
          existingRange: { minimumVersion: 2, highestVersion: 3 },
        },
      ),
    ),
    /cannot retire persistence version 2 while a reconciliation ticket retains it/,
  );
});

test('stage exige aussi les clés de réconciliation retenues hors de la plage courante', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3')),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedReconciliation: [2],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
        },
      ),
    ),
    /does not cover every admitted or retained persistence version/,
  );
});

test('la release refuse de perdre toute clé identité encore référencée par un bootstrap', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', withIdentity(enabled('3', ['2']), '8')),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          retainedIdentity: [7],
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
        },
      ),
    ),
    /identity encryption keyring does not cover every retained bootstrap version/,
  );
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3', ['2'])),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          retainedIdentity: [7],
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
        },
      ),
    ),
    /identity encryption keyring is required for retained bootstrap versions/,
  );
  await assert.doesNotReject(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation(
        'stage',
        withIdentity(enabled('3', ['2']), '8', ['7']),
      ),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          retainedIdentity: [7],
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
          identityResultRange: { minimumVersion: 7, highestVersion: 8 },
        },
      ),
    ),
  );
});

test('stage verrouille persistance puis identité puis sujet et prépare les plages atomiquement', async () => {
  const prisma = prismaReturning(
    { minimumVersion: 2, highestVersion: 3 },
    {
      existingRange: { minimumVersion: 2, highestVersion: 2 },
      existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
      identityResultRange: { minimumVersion: 7, highestVersion: 8 },
    },
  );
  const result = await manageMistralConversationKeyVersion(
    parseMistralKeyVersionOperation(
      'stage',
      withIdentity(enabled('3', ['2']), '8', ['7']),
    ),
    prisma,
  );
  assert.deepEqual(result, { status: 'staged', minimumVersion: 2, highestVersion: 3 });
  const lockSpaces = prisma.executions()
    .filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    .map(({ values }) => values[0]);
  assert.deepEqual(lockSpaces.slice(0, 3), [
    'mistral-conversation-persistence-v1',
    'mistral-conversation-bootstrap-identity-v1',
    'bob-live-subject-hmac-v1',
  ]);
});

test('la release conserve toute clé sujet référencée par bootstrap, Mission ou reçu terminal', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', withSubject(enabled(), '2')),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedSubject: [1],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
          existingSubjectRange: { minimumVersion: 1, highestVersion: 1 },
          subjectResultRange: { minimumVersion: 1, highestVersion: 2 },
        },
      ),
    ),
    /does not cover every retained subject version/u,
  );

  await assert.doesNotReject(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation(
        'stage',
        withSubject(enabled(), '2', ['1']),
      ),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedSubject: [1],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
          existingSubjectRange: { minimumVersion: 1, highestVersion: 1 },
          subjectResultRange: { minimumVersion: 1, highestVersion: 2 },
        },
      ),
    ),
  );
});

test('retire ferme les anciens writers sujet sans perdre le secret des reçus historiques', async () => {
  const retainedConfiguration = parseMistralKeyVersionOperation(
    'retire',
    withSubject(enabled(), '2', ['1']),
  );
  await assert.doesNotReject(
    manageMistralConversationKeyVersion(
      retainedConfiguration,
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedSubject: [1],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
          existingSubjectRange: { minimumVersion: 1, highestVersion: 2 },
          subjectResultRange: { minimumVersion: 2, highestVersion: 2 },
        },
      ),
    ),
  );

  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('retire', withSubject(enabled(), '2')),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedSubject: [1],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
          existingSubjectRange: { minimumVersion: 2, highestVersion: 2 },
          subjectResultRange: { minimumVersion: 2, highestVersion: 2 },
        },
      ),
    ),
    /does not cover every retained subject version/u,
  );
});

test('une version sujet engagée ne peut jamais changer de matériau', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation(
        'stage',
        withSubject(enabled(), '2', ['1']),
      ),
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedSubject: [1],
          existingRange: { minimumVersion: 3, highestVersion: 3 },
          existingSubjectRange: { minimumVersion: 1, highestVersion: 1 },
          subjectResultRange: { minimumVersion: 1, highestVersion: 2 },
          mismatchedSubjectBindingVersion: 1,
        },
      ),
    ),
    /key material changed for subject HMAC version 1/u,
  );
});

test('retire identité refuse le writer retenu puis exige une plage stable exacte', async () => {
  const config = parseMistralKeyVersionOperation(
    'retire',
    withIdentity(enabled('3', ['2']), '8', ['7']),
  );
  await assert.rejects(
    manageMistralConversationKeyVersion(
      config,
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          retainedIdentity: [7],
          existingRange: { minimumVersion: 2, highestVersion: 3 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 8 },
        },
      ),
    ),
    /cannot retire identity encryption version 7 while a bootstrap ticket retains it/,
  );
  await assert.rejects(
    manageMistralConversationKeyVersion(
      config,
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          existingRange: { minimumVersion: 2, highestVersion: 3 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 8 },
          identityResultRange: { minimumVersion: 7, highestVersion: 8 },
        },
      ),
    ),
    /identity retirement did not reach version 8/,
  );
  await assert.doesNotReject(
    manageMistralConversationKeyVersion(
      config,
      prismaReturning(
        { minimumVersion: 3, highestVersion: 3 },
        {
          existingRange: { minimumVersion: 2, highestVersion: 3 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 8 },
          identityResultRange: { minimumVersion: 8, highestVersion: 8 },
        },
      ),
    ),
  );
});

test('une plage identité durable interdit l’omission ou le changement silencieux de matière', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3', ['2'])),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
        },
      ),
    ),
    /identity encryption keyring is required for the durable identity range/,
  );
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation(
        'stage',
        withIdentity(enabled('3', ['2']), '8', ['7']),
      ),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          existingIdentityRange: { minimumVersion: 7, highestVersion: 7 },
          mismatchedIdentityBindingVersion: 7,
        },
      ),
    ),
    /key material changed for identity encryption version 7/,
  );
});

test('la plage mixte exige aussi la clé de l’ancien replica avant tout stage', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3')),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        { existingRange: { minimumVersion: 2, highestVersion: 2 } },
      ),
    ),
    /does not cover every admitted or retained persistence version/,
  );
});

test('une version déjà engagée ne peut jamais changer de matériau', async () => {
  await assert.rejects(
    manageMistralConversationKeyVersion(
      parseMistralKeyVersionOperation('stage', enabled('3', ['2'])),
      prismaReturning(
        { minimumVersion: 2, highestVersion: 3 },
        {
          existingRange: { minimumVersion: 2, highestVersion: 2 },
          mismatchedBindingVersion: 2,
        },
      ),
    ),
    /key material changed for persistence version 2/,
  );
});

test('la migration additive arme le même verrou/plancher pour les r2 sans toucher aux reprises standard', async () => {
  const migration = await readFile(new URL(
    '../prisma/migrations/20260719060000_mistral_conversation_reconciliation_key_floor/migration.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION enforce_mistral_conversation_persistence_key_range\(\)[\s\S]*realtime_mistral_conversation_resume_tickets/u,
  );
  assert.match(
    migration,
    /NEW\.purpose = 'standard_resume'[\s\S]*NEW\."reconciliationKeyVersion" IS NULL[\s\S]*RETURN NEW/u,
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock_shared[\s\S]*written_version := NEW\."reconciliationKeyVersion"/u,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "00_realtime_mistral_conversation_resume_ticket_key_version_guard"/u,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_version_floor\(\)[\s\S]*"reconciliationKeyVersion" = OLD\."minimumVersion"[\s\S]*MISTRAL_CONVERSATION_RECONCILIATION_KEY_VERSION_RETAINED/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "realtime_mistral_conversation_resume_tickets" ENABLE ROW LEVEL SECURITY;[\s\S]*ALTER TABLE "realtime_mistral_conversation_resume_tickets" FORCE ROW LEVEL SECURITY;/u,
  );
});

test('la migration identité est dormante sans ligne et sérialise writer, seed et retirement', async () => {
  const migration = await readFile(new URL(
    '../prisma/migrations/20260719070000_mistral_conversation_identity_key_floor/migration.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(
    migration,
    /SELECT DISTINCT "identityEncryptionKeyVersion" AS version[\s\S]*IF observed_count > 0 THEN[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_SEED_UNSAFE/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION enforce_mistral_conversation_identity_key_range\(\)[\s\S]*pg_advisory_xact_lock_shared[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RANGE_UNINITIALIZED/u,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "00_mistral_bootstrap_identity_key_version_guard"[\s\S]*BEFORE INSERT ON "realtime_mistral_conversation_bootstrap_tickets"/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION enforce_mistral_conversation_identity_key_version_floor\(\)[\s\S]*"identityEncryptionKeyVersion" = OLD\."minimumVersion"[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RETAINED/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "realtime_mistral_conversation_identity_key_version_floors"[\s\S]*FORCE ROW LEVEL SECURITY[\s\S]*ALTER TABLE "realtime_mistral_conversation_identity_key_bindings"[\s\S]*FORCE ROW LEVEL SECURITY/u,
  );
});

test('la migration sujet sérialise la rotation et garde toutes les preuves historiques', async () => {
  const migration = await readFile(new URL(
    '../prisma/migrations/20260719083000_mistral_conversation_subject_key_floor/migration.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(
    migration,
    /'mistral-conversation-persistence-v1'[\s\S]*'mistral-conversation-bootstrap-identity-v1'[\s\S]*'bob-live-subject-hmac-v1'/u,
  );
  assert.match(
    migration,
    /SELECT "subjectKeyVersion" AS version[\s\S]*realtime_mistral_conversation_bootstrap_tickets[\s\S]*realtime_mistral_conversation_missions[\s\S]*realtime_mistral_conversation_terminal_receipts/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION lock_mistral_bootstrap_persistence_key_order\(\)[\s\S]*pg_advisory_xact_lock_shared[\s\S]*CREATE TRIGGER "00_mistral_bootstrap_00_persistence_key_order_guard"/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION enforce_bob_live_subject_hmac_key_range\(\)[\s\S]*BOB_LIVE_SUBJECT_KEY_VERSION_RANGE_UNINITIALIZED[\s\S]*BOB_LIVE_SUBJECT_KEY_VERSION_NOT_ADMITTED[\s\S]*realtime_mistral_conversation_key_bindings[\s\S]*BOB_LIVE_SUBJECT_KEY_VERSION_UNBOUND/u,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "01_mistral_bootstrap_subject_key_version_guard"[\s\S]*CREATE TRIGGER "00_mistral_mission_subject_key_version_guard"/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION retained_bob_live_subject_hmac_key_bindings\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET row_security = off[\s\S]*realtime_mistral_conversation_bootstrap_tickets[\s\S]*realtime_mistral_conversation_missions[\s\S]*realtime_mistral_conversation_terminal_receipts/u,
  );
  assert.doesNotMatch(
    migration.slice(migration.indexOf('CREATE FUNCTION retained_bob_live_subject_hmac_key_bindings')),
    /SELECT[^;]*(?:"companyId"|"subjectHash")/u,
  );
  assert.match(
    migration,
    /locked_key_space = 'mistral-conversation-persistence-v1'[\s\S]*MISTRAL_CONVERSATION_RECONCILIATION_KEY_VERSION_RETAINED/u,
  );
});
