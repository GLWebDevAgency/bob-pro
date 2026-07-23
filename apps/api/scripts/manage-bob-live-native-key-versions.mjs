#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const SUBJECT_KEY_SPACE = 'bob-live-subject-hmac-v1';
const PROOF_KEY_SPACE = 'openai-native-speech-proof-hmac-v1';
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const VERSION = /^[1-9][0-9]{0,9}$/u;

function fail(message) {
  throw new Error(`bob-live-native-key-version:${message}`);
}

function parseVersion(raw, label) {
  if (typeof raw !== 'string' || !VERSION.test(raw)) fail(`${label} is invalid`);
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version > POSTGRES_INTEGER_MAX) {
    fail(`${label} exceeds PostgreSQL integer range`);
  }
  return version;
}

function parseKeyring(raw, currentVersion, label, maximumKeys) {
  let decoded;
  try {
    decoded = JSON.parse(raw ?? '');
  } catch {
    fail(`${label} must be valid JSON`);
  }
  if (
    decoded === null
    || typeof decoded !== 'object'
    || Array.isArray(decoded)
    || Object.getPrototypeOf(decoded) !== Object.prototype
  ) fail(`${label} must be an object`);
  const entries = Object.entries(decoded);
  if (entries.length < 1 || entries.length > maximumKeys) fail(`${label} size is invalid`);

  const seenSecrets = new Set();
  const bindings = entries.map(([rawVersion, secret]) => {
    const version = parseVersion(rawVersion, `${label} version`);
    if (
      typeof secret !== 'string'
      || Buffer.byteLength(secret, 'utf8') < 32
      || Buffer.byteLength(secret, 'utf8') > 512
      || secret.includes('[')
      || secret.includes(']')
      || [...secret].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x21 || codePoint > 0x7e;
      })
      || seenSecrets.has(secret)
    ) fail(`${label} contains an invalid or reused secret`);
    seenSecrets.add(secret);
    return Object.freeze({
      version,
      secret,
      fingerprint: createHash('sha256').update(secret, 'utf8').digest('hex'),
    });
  }).sort((left, right) => left.version - right.version);
  if (!bindings.some((binding) => binding.version === currentVersion)) {
    fail(`${label} does not contain the current version`);
  }
  return Object.freeze(bindings);
}

export function parseBobLiveNativeKeyVersionOperation(mode, environment = process.env) {
  if (mode !== 'stage' && mode !== 'retire') fail('mode must be stage or retire');
  const proofConfigured = environment.BOB_LIVE_PROOF_KEYRING !== undefined;
  // Une bascule temporaire vers Mistral ne rend pas les preuves OpenAI déjà persistées orphelines :
  // dès que la keyring native est conservée dans l'environnement, stage/retire restent actifs.
  if (!proofConfigured) {
    return Object.freeze({ enabled: false, mode });
  }
  const directUrl = environment.DIRECT_URL?.trim() ?? '';
  if (!directUrl) fail('DIRECT_URL is required');
  const subjectCurrentVersion = parseVersion(
    environment.BOB_LIVE_SUBJECT_KEY_VERSION ?? '1',
    'BOB_LIVE_SUBJECT_KEY_VERSION',
  );
  const proofCurrentVersion = parseVersion(
    environment.BOB_LIVE_PROOF_KEY_VERSION ?? '',
    'BOB_LIVE_PROOF_KEY_VERSION',
  );
  const subjectBindings = parseKeyring(
    environment.BOB_LIVE_SUBJECT_HMAC_KEYRING,
    subjectCurrentVersion,
    'BOB_LIVE_SUBJECT_HMAC_KEYRING',
    32,
  );
  const proofBindings = parseKeyring(
    environment.BOB_LIVE_PROOF_KEYRING,
    proofCurrentVersion,
    'BOB_LIVE_PROOF_KEYRING',
    2,
  );
  if (
    proofBindings.at(-1)?.version !== proofCurrentVersion
    || (proofBindings.length === 2
      && proofBindings[1].version !== proofBindings[0].version + 1)
  ) fail('proof keyring must contain current and optional adjacent N-1 only');
  const allSecrets = [...subjectBindings, ...proofBindings].map((binding) => binding.secret);
  if (new Set(allSecrets).size !== allSecrets.length) {
    fail('subject and proof key material must be dedicated');
  }
  const legacyProof = environment.BOB_LIVE_PROOF_SECRET
    ?? environment.OPENAI_REALTIME_PROOF_SECRET
    ?? null;
  const currentProof = proofBindings.find((binding) => binding.version === proofCurrentVersion);
  if (legacyProof !== null && legacyProof !== currentProof?.secret) {
    fail('legacy proof secret does not match current proof keyring version');
  }
  const legacySubject = environment.BOB_LIVE_SUBJECT_HMAC_SECRET
    ?? environment.OPENAI_REALTIME_SAFETY_SECRET
    ?? null;
  const currentSubject = subjectBindings.find(
    (binding) => binding.version === subjectCurrentVersion,
  );
  if (legacySubject !== null && legacySubject !== currentSubject?.secret) {
    fail('legacy subject secret does not match current subject keyring version');
  }
  return Object.freeze({
    enabled: true,
    mode,
    directUrl,
    subjectCurrentVersion,
    subjectBindings,
    proofCurrentVersion,
    proofBindings,
  });
}

function validRange(range) {
  return range
    && Number.isInteger(range.minimumVersion)
    && Number.isInteger(range.highestVersion)
    && range.minimumVersion >= 1
    && range.highestVersion >= range.minimumVersion
    && range.highestVersion <= range.minimumVersion + 1;
}

async function bindConfiguredKeys(tx, keySpace, bindings) {
  for (const binding of bindings) {
    await tx.$executeRaw`
      INSERT INTO realtime_mistral_conversation_key_bindings (
        "keySpace", "keyVersion", "keyFingerprint"
      ) VALUES (${keySpace}, ${binding.version}, ${binding.fingerprint})
      ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
    `;
    const rows = await tx.$queryRaw`
      SELECT "keyFingerprint"::text AS "keyFingerprint"
        FROM realtime_mistral_conversation_key_bindings
       WHERE "keySpace" = ${keySpace}
         AND "keyVersion" = ${binding.version}
    `;
    if (rows.length !== 1 || rows[0]?.keyFingerprint !== binding.fingerprint) {
      fail(`${keySpace} version ${binding.version} material mismatch`);
    }
  }
}

async function readRange(tx, keySpace) {
  const rows = await tx.$queryRaw`
    SELECT "minimumVersion", "highestVersion"
      FROM realtime_mistral_conversation_key_version_floors
     WHERE "keySpace" = ${keySpace}
  `;
  if (rows.length > 1) fail(`${keySpace} returned multiple durable ranges`);
  const range = rows[0] ?? null;
  if (range !== null && !validRange(range)) fail(`${keySpace} durable range is invalid`);
  return range;
}

async function stageRange(tx, keySpace, currentVersion, tableIsEmpty) {
  const range = await readRange(tx, keySpace);
  if (range === null) {
    if (!tableIsEmpty) {
      fail(`${keySpace} cannot initialize after an unregistered native delivery`);
    }
    const rows = await tx.$queryRaw`
      INSERT INTO realtime_mistral_conversation_key_version_floors (
        "keySpace", "minimumVersion", "highestVersion"
      ) VALUES (${keySpace}, ${currentVersion}, ${currentVersion})
      RETURNING "minimumVersion", "highestVersion"
    `;
    if (rows.length !== 1 || !validRange(rows[0])) fail(`${keySpace} initialization failed`);
    return rows[0];
  }
  if (currentVersion >= range.minimumVersion && currentVersion <= range.highestVersion) {
    return range;
  }
  if (range.minimumVersion !== range.highestVersion || currentVersion !== range.highestVersion + 1) {
    fail(`${keySpace} refuses a non-adjacent stage`);
  }
  const rows = await tx.$queryRaw`
    UPDATE realtime_mistral_conversation_key_version_floors
       SET "highestVersion" = ${currentVersion}
     WHERE "keySpace" = ${keySpace}
       AND "minimumVersion" = ${range.minimumVersion}
       AND "highestVersion" = ${range.highestVersion}
    RETURNING "minimumVersion", "highestVersion"
  `;
  if (rows.length !== 1 || !validRange(rows[0])) fail(`${keySpace} stage failed`);
  return rows[0];
}

async function retireRange(tx, keySpace, currentVersion) {
  const range = await readRange(tx, keySpace);
  if (range === null) fail(`${keySpace} is not initialized`);
  if (range.minimumVersion === currentVersion && range.highestVersion === currentVersion) {
    return range;
  }
  if (
    range.minimumVersion + 1 !== currentVersion
    || range.highestVersion !== currentVersion
  ) fail(`${keySpace} retirement target is invalid`);
  const rows = await tx.$queryRaw`
    UPDATE realtime_mistral_conversation_key_version_floors
       SET "minimumVersion" = ${currentVersion}
     WHERE "keySpace" = ${keySpace}
       AND "minimumVersion" = ${range.minimumVersion}
       AND "highestVersion" = ${range.highestVersion}
    RETURNING "minimumVersion", "highestVersion"
  `;
  if (
    rows.length !== 1
    || rows[0]?.minimumVersion !== currentVersion
    || rows[0]?.highestVersion !== currentVersion
  ) fail(`${keySpace} retirement failed`);
  return rows[0];
}

function validLegacySubjectAdmission(row) {
  return (
    (row?.phase === 'open' && row?.revision === 1)
    || (row?.phase === 'closed' && row?.revision === 2)
  );
}

async function readLegacySubjectAdmission(tx) {
  const rows = await tx.$queryRaw`
    SELECT phase, revision
      FROM realtime_native_legacy_subject_admission
     WHERE gate = 'subject-null-v1'
  `;
  if (rows.length !== 1 || !validLegacySubjectAdmission(rows[0])) {
    fail('legacy subject admission gate is missing or invalid');
  }
  return rows[0];
}

async function closeLegacySubjectAdmission(tx) {
  const gate = await readLegacySubjectAdmission(tx);
  if (gate.phase === 'closed') return gate;
  const rows = await tx.$queryRaw`
    UPDATE realtime_native_legacy_subject_admission
       SET phase = 'closed',
           revision = 2
     WHERE gate = 'subject-null-v1'
       AND phase = 'open'
       AND revision = 1
       AND "closedAt" IS NULL
    RETURNING phase, revision
  `;
  if (rows.length !== 1 || rows[0]?.phase !== 'closed' || rows[0]?.revision !== 2) {
    fail('legacy subject admission gate closure failed');
  }
  return rows[0];
}

function assertConfiguredCoverage(keySpace, bindings, range, retained) {
  const configured = new Map(bindings.map((binding) => [binding.version, binding.fingerprint]));
  const required = new Set([range.minimumVersion, range.highestVersion]);
  for (const row of retained) {
    if (!Number.isInteger(row.keyVersion) || typeof row.keyFingerprint !== 'string') {
      fail(`${keySpace} retained binding is invalid`);
    }
    required.add(row.keyVersion);
    if (configured.get(row.keyVersion) !== row.keyFingerprint) {
      fail(`${keySpace} keyring does not cover retained version ${row.keyVersion}`);
    }
  }
  for (const version of required) {
    if (!configured.has(version)) fail(`${keySpace} keyring does not cover admitted version`);
  }
}

export async function manageBobLiveNativeKeyVersions(config, prisma) {
  if (!config.enabled) return Object.freeze({ status: 'disabled' });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${SUBJECT_KEY_SPACE}, 0))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${PROOF_KEY_SPACE}, 0))
    `;
    const [{ deliveryCount }] = await tx.$queryRaw`
      SELECT count(*)::integer AS "deliveryCount"
        FROM realtime_native_speech_deliveries
    `;
    const tableIsEmpty = deliveryCount === 0;
    if (!Number.isInteger(deliveryCount) || deliveryCount < 0) {
      fail('database returned an invalid native delivery count');
    }

    await bindConfiguredKeys(tx, SUBJECT_KEY_SPACE, config.subjectBindings);
    await bindConfiguredKeys(tx, PROOF_KEY_SPACE, config.proofBindings);

    if (config.mode === 'retire') {
      const [{ liveOwnerCount }] = await tx.$queryRaw`
        SELECT count(*)::integer AS "liveOwnerCount"
          FROM realtime_session_leases
         WHERE "providerId" = 'openai'
           AND "sidebandOwnerTokenHash" IS NOT NULL
           AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
      `;
      if (liveOwnerCount !== 0) fail('retirement is blocked by a live OpenAI owner');
    }

    const legacySubjectAdmission = config.mode === 'retire'
      ? await closeLegacySubjectAdmission(tx)
      : await readLegacySubjectAdmission(tx);
    const subjectRange = config.mode === 'stage'
      ? await stageRange(tx, SUBJECT_KEY_SPACE, config.subjectCurrentVersion, tableIsEmpty)
      : await retireRange(tx, SUBJECT_KEY_SPACE, config.subjectCurrentVersion);
    const proofRange = config.mode === 'stage'
      ? await stageRange(tx, PROOF_KEY_SPACE, config.proofCurrentVersion, tableIsEmpty)
      : await retireRange(tx, PROOF_KEY_SPACE, config.proofCurrentVersion);

    const retainedSubject = await tx.$queryRaw`
      SELECT "keyVersion", "keyFingerprint"
        FROM retained_bob_live_subject_hmac_key_bindings()
       ORDER BY "keyVersion"
    `;
    const retainedProof = await tx.$queryRaw`
      SELECT "keyVersion", "keyFingerprint"
        FROM retained_openai_native_proof_hmac_key_bindings()
       ORDER BY "keyVersion"
    `;
    assertConfiguredCoverage(
      SUBJECT_KEY_SPACE,
      config.subjectBindings,
      subjectRange,
      retainedSubject,
    );
    assertConfiguredCoverage(PROOF_KEY_SPACE, config.proofBindings, proofRange, retainedProof);

    return Object.freeze({
      status: config.mode === 'stage' ? 'staged' : 'retired',
      legacySubjectAdmissionPhase: legacySubjectAdmission.phase,
      subjectRange: Object.freeze({ ...subjectRange }),
      proofRange: Object.freeze({ ...proofRange }),
    });
  });
}

async function main() {
  let prisma;
  try {
    const config = parseBobLiveNativeKeyVersionOperation(process.argv[2]);
    if (!config.enabled) {
      console.log(`bob-live-native-key-version:${config.mode}:disabled`);
      return;
    }
    prisma = new PrismaClient({ datasourceUrl: config.directUrl });
    await prisma.$connect();
    const result = await manageBobLiveNativeKeyVersions(config, prisma);
    console.log(`bob-live-native-key-version:${result.status}`);
  } catch {
    console.error('bob-live-native-key-version:error');
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith('manage-bob-live-native-key-versions.mjs')) {
  await main();
}
