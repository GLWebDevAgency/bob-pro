import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  manageBobLiveNativeKeyVersions,
  parseBobLiveNativeKeyVersionOperation,
} from './manage-bob-live-native-key-versions.mjs';

const subject = (version) => `subject-${version}-`.padEnd(40, 's');
const proof = (version) => `proof-${version}-`.padEnd(40, 'p');
const fingerprint = (secret) => createHash('sha256').update(secret, 'utf8').digest('hex');

function environment(subjectVersion = 1, proofVersion = 1, previous = false) {
  const subjectRing = previous
    ? { [subjectVersion - 1]: subject(subjectVersion - 1), [subjectVersion]: subject(subjectVersion) }
    : { [subjectVersion]: subject(subjectVersion) };
  const proofRing = previous
    ? { [proofVersion - 1]: proof(proofVersion - 1), [proofVersion]: proof(proofVersion) }
    : { [proofVersion]: proof(proofVersion) };
  return {
    BOB_LIVE_PROVIDER: 'openai',
    BOB_LIVE_SUBJECT_KEY_VERSION: String(subjectVersion),
    BOB_LIVE_SUBJECT_HMAC_SECRET: subject(subjectVersion),
    BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify(subjectRing),
    BOB_LIVE_PROOF_KEY_VERSION: String(proofVersion),
    BOB_LIVE_PROOF_SECRET: proof(proofVersion),
    BOB_LIVE_PROOF_KEYRING: JSON.stringify(proofRing),
    DIRECT_URL: 'postgresql://admin.invalid/bob',
  };
}

function fakePrisma({
  deliveryCount = 0,
  liveOwnerCount = 0,
  ranges = {},
  bindings = {},
  retainedSubject = [],
  retainedProof = [],
  legacySubjectAdmissionPhase = 'open',
} = {}) {
  const durableRanges = new Map(Object.entries(ranges));
  const durableBindings = new Map(Object.entries(bindings));
  const legacySubjectAdmission = {
    phase: legacySubjectAdmissionPhase,
    revision: legacySubjectAdmissionPhase === 'open' ? 1 : 2,
  };
  const key = (keySpace, version) => `${keySpace}:${version}`;
  return {
    ranges: durableRanges,
    bindings: durableBindings,
    legacySubjectAdmission,
    $transaction: async (callback) => callback({
      $executeRaw: async (strings, ...values) => {
        const sql = strings.join('?');
        if (sql.includes('INSERT INTO realtime_mistral_conversation_key_bindings')) {
          const [keySpace, version, keyFingerprint] = values;
          const bindingKey = key(keySpace, version);
          if (!durableBindings.has(bindingKey)) durableBindings.set(bindingKey, keyFingerprint);
        }
        return 1;
      },
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('?');
        if (sql.includes('count(*)::integer AS "deliveryCount"')) return [{ deliveryCount }];
        if (sql.includes('count(*)::integer AS "liveOwnerCount"')) return [{ liveOwnerCount }];
        if (
          sql.includes('FROM realtime_native_legacy_subject_admission')
          && sql.includes('SELECT phase, revision')
        ) return [{ ...legacySubjectAdmission }];
        if (sql.includes('UPDATE realtime_native_legacy_subject_admission')) {
          if (
            legacySubjectAdmission.phase !== 'open'
            || legacySubjectAdmission.revision !== 1
          ) return [];
          legacySubjectAdmission.phase = 'closed';
          legacySubjectAdmission.revision = 2;
          return [{ ...legacySubjectAdmission }];
        }
        if (sql.includes('FROM retained_bob_live_subject_hmac_key_bindings')) {
          return retainedSubject.map((version) => ({
            keyVersion: version,
            keyFingerprint: durableBindings.get(key('bob-live-subject-hmac-v1', version)) ?? null,
          }));
        }
        if (sql.includes('FROM retained_openai_native_proof_hmac_key_bindings')) {
          return retainedProof.map((version) => ({
            keyVersion: version,
            keyFingerprint:
              durableBindings.get(key('openai-native-speech-proof-hmac-v1', version)) ?? null,
          }));
        }
        if (
          sql.includes('FROM realtime_mistral_conversation_key_bindings')
          && sql.includes('SELECT "keyFingerprint"')
        ) {
          const [keySpace, version] = values;
          const value = durableBindings.get(key(keySpace, version));
          return value === undefined ? [] : [{ keyFingerprint: value }];
        }
        if (
          sql.includes('FROM realtime_mistral_conversation_key_version_floors')
          && sql.includes('SELECT "minimumVersion"')
        ) {
          const [keySpace] = values;
          const range = durableRanges.get(keySpace);
          return range ? [{ ...range }] : [];
        }
        if (sql.includes('INSERT INTO realtime_mistral_conversation_key_version_floors')) {
          const [keySpace, minimumVersion, highestVersion] = values;
          const range = { minimumVersion, highestVersion };
          durableRanges.set(keySpace, range);
          return [{ ...range }];
        }
        if (sql.includes('UPDATE realtime_mistral_conversation_key_version_floors')) {
          const [nextVersion, keySpace] = values;
          const existing = durableRanges.get(keySpace);
          if (!existing) return [];
          const range = sql.includes('SET "highestVersion"')
            ? { ...existing, highestVersion: nextVersion }
            : { ...existing, minimumVersion: nextVersion };
          durableRanges.set(keySpace, range);
          return [{ ...range }];
        }
        return [];
      },
    }),
  };
}

test('le lifecycle natif reste dormant sans keyring mais survit à une bascule de fournisseur', () => {
  assert.deepEqual(parseBobLiveNativeKeyVersionOperation('stage', {}), {
    enabled: false,
    mode: 'stage',
  });
  expectProviderNeutral(parseBobLiveNativeKeyVersionOperation('stage', {
    ...environment(),
    BOB_LIVE_PROVIDER: 'mistral',
  }));
});

function expectProviderNeutral(parsed) {
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.mode, 'stage');
  assert.equal(parsed.subjectCurrentVersion, 1);
  assert.equal(parsed.proofCurrentVersion, 1);
}

test('le parseur impose N-1/N, la version courante et des matériaux dédiés', () => {
  const parsed = parseBobLiveNativeKeyVersionOperation('stage', environment(2, 2, true));
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.proofBindings.map(({ version }) => version), [1, 2]);

  assert.throws(() => parseBobLiveNativeKeyVersionOperation('stage', {
    ...environment(3, 3),
    BOB_LIVE_PROOF_KEYRING: JSON.stringify({ 1: proof(1), 3: proof(3) }),
  }), /adjacent/);
  assert.throws(() => parseBobLiveNativeKeyVersionOperation('stage', {
    ...environment(),
    BOB_LIVE_PROOF_KEYRING: JSON.stringify({ 1: subject(1) }),
    BOB_LIVE_PROOF_SECRET: subject(1),
  }), /dedicated/);
});

test('stage initialise atomiquement sujet et preuve sur une table native vide', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('stage', environment());
  const prisma = fakePrisma();
  const result = await manageBobLiveNativeKeyVersions(config, prisma);
  assert.equal(result.status, 'staged');
  assert.equal(result.legacySubjectAdmissionPhase, 'open');
  assert.deepEqual(prisma.ranges.get('bob-live-subject-hmac-v1'), {
    minimumVersion: 1,
    highestVersion: 1,
  });
  assert.deepEqual(prisma.ranges.get('openai-native-speech-proof-hmac-v1'), {
    minimumVersion: 1,
    highestVersion: 1,
  });
});

test('retire ferme le gate legacy même sans rotation artificielle', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('retire', environment());
  const prisma = fakePrisma({
    ranges: {
      'bob-live-subject-hmac-v1': { minimumVersion: 1, highestVersion: 1 },
      'openai-native-speech-proof-hmac-v1': { minimumVersion: 1, highestVersion: 1 },
    },
  });
  const result = await manageBobLiveNativeKeyVersions(config, prisma);
  assert.equal(result.status, 'retired');
  assert.equal(result.legacySubjectAdmissionPhase, 'closed');
  assert.deepEqual(prisma.legacySubjectAdmission, { phase: 'closed', revision: 2 });
});

test('stage échoue fermé devant un gate legacy corrompu', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('stage', environment());
  await assert.rejects(
    manageBobLiveNativeKeyVersions(
      config,
      fakePrisma({ legacySubjectAdmissionPhase: 'corrupt' }),
    ),
    /legacy subject admission gate is missing or invalid/u,
  );
});

test('le premier stage refuse une table historique non enregistrée', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('stage', environment());
  await assert.rejects(
    manageBobLiveNativeKeyVersions(config, fakePrisma({ deliveryCount: 1 })),
    /cannot initialize after an unregistered native delivery/,
  );
});

test('A/v1 puis B/v1 est refusé sans réécrire le binding append-only', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('stage', environment());
  const subjectKey = 'bob-live-subject-hmac-v1:1';
  const proofKey = 'openai-native-speech-proof-hmac-v1:1';
  const prisma = fakePrisma({
    ranges: {
      'bob-live-subject-hmac-v1': { minimumVersion: 1, highestVersion: 1 },
      'openai-native-speech-proof-hmac-v1': { minimumVersion: 1, highestVersion: 1 },
    },
    bindings: {
      [subjectKey]: fingerprint(subject(1)),
      [proofKey]: fingerprint('different-proof-material'.padEnd(40, 'x')),
    },
  });
  await assert.rejects(
    manageBobLiveNativeKeyVersions(config, prisma),
    /material mismatch/,
  );
  assert.equal(prisma.bindings.get(proofKey), fingerprint('different-proof-material'.padEnd(40, 'x')));
});

test('retire refuse tout owner OpenAI encore vivant', async () => {
  const config = parseBobLiveNativeKeyVersionOperation('retire', environment(2, 2, true));
  await assert.rejects(
    manageBobLiveNativeKeyVersions(config, fakePrisma({ liveOwnerCount: 1 })),
    /live OpenAI owner/,
  );
});

test('la migration grave l’immutabilité, la rétention et les deux verrous', async () => {
  const keyLifecycleMigration = await readFile(new URL(
    '../prisma/migrations/20260722060000_openai_native_key_lifecycle/migration.sql',
    import.meta.url,
  ), 'utf8');
  const rollingGateMigration = await readFile(new URL(
    '../prisma/migrations/20260724010000_openai_native_legacy_subject_gate/migration.sql',
    import.meta.url,
  ), 'utf8');
  assert.match(keyLifecycleMigration, /ADD COLUMN "subjectKeyVersion" INTEGER/);
  assert.match(keyLifecycleMigration, /"subjectKeyVersion" IS NULL/);
  assert.match(keyLifecycleMigration, /openai-native-speech-proof-hmac-v1/);
  assert.match(keyLifecycleMigration, /retained_openai_native_proof_hmac_key_bindings/);
  assert.match(rollingGateMigration, /realtime_native_legacy_subject_admission/);
  assert.match(rollingGateMigration, /OLD\.phase <> 'open'[\s\S]*NEW\.phase <> 'closed'/u);
  assert.match(
    rollingGateMigration,
    /NEW\."subjectKeyVersion" IS NULL[\s\S]*legacy_subject_admission_open IS DISTINCT FROM TRUE/u,
  );
  assert.match(
    rollingGateMigration,
    /pg_advisory_xact_lock_shared[\s\S]*bob-live-subject-hmac-v1[\s\S]*pg_advisory_xact_lock_shared[\s\S]*openai-native-speech-proof-hmac-v1/u,
  );
  assert.match(
    rollingGateMigration,
    /NEW\."subjectKeyVersion"[\s\S]*OLD\."subjectKeyVersion"/u,
  );
});
