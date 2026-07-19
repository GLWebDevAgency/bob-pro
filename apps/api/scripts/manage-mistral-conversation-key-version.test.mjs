import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    DIRECT_URL: 'postgresql://admin.invalid/bob',
  };
}

function fingerprint(version) {
  return createHash('sha256')
    .update(Buffer.alloc(32, Number(version) % 255))
    .digest('hex');
}

function prismaReturning(
  range,
  {
    retained = [],
    existingRange = null,
    mismatchedBindingVersion = null,
  } = {},
) {
  let queryCount = 0;
  return {
    queryCount: () => queryCount,
    $transaction: async (callback) => callback({
      $executeRaw: async () => {
        queryCount += 1;
        return 1;
      },
      $queryRaw: async (strings, ...values) => {
        queryCount += 1;
        const sql = strings.join('?');
        if (sql.includes('retained_versions')) {
          return retained.map((version) => ({ version }));
        }
        if (
          sql.includes('FROM realtime_mistral_conversation_key_version_floors')
          && sql.includes('SELECT "minimumVersion"')
        ) return existingRange ? [existingRange] : [];
        if (sql.includes('FROM realtime_mistral_conversation_key_bindings')) {
          const version = Number(values.at(-1));
          return [{
            keyFingerprint: version === mismatchedBindingVersion
              ? 'f'.repeat(64)
              : fingerprint(version),
          }];
        }
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
