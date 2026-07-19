#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const KEY_SPACE = 'mistral-conversation-persistence-v1';
const IDENTITY_KEY_SPACE = 'mistral-conversation-bootstrap-identity-v1';
const SUBJECT_KEY_SPACE = 'bob-live-subject-hmac-v1';
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_KEYRING_SIZE = 8;
const MAX_IDENTITY_KEYRING_JSON_LENGTH = 4_096;
const MAX_SUBJECT_KEYRING_SIZE = 32;
const MAX_SUBJECT_KEYRING_JSON_LENGTH = 4_096;
const CANONICAL_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const CANONICAL_IDENTITY_VERSION = /^[1-9][0-9]{0,9}$/u;
const CANONICAL_SUBJECT_VERSION = /^[1-9][0-9]{0,9}$/u;

function fail(message) {
  throw new Error(`mistral-key-version:${message}`);
}

export function parseMistralKeyVersionOperation(
  mode,
  environment = process.env,
) {
  if (mode !== 'stage' && mode !== 'retire') fail('mode must be stage or retire');
  const enabled = environment.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') {
    fail('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED must be true or false');
  }
  const initialBootstrapEnabled =
    environment.BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED ?? 'false';
  if (initialBootstrapEnabled !== 'true' && initialBootstrapEnabled !== 'false') {
    fail('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED must be true or false');
  }
  const identityVersionConfigured =
    environment.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION !== undefined;
  const identityKeyringConfigured =
    environment.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING !== undefined;
  if (enabled === 'false') {
    if (initialBootstrapEnabled === 'true') fail('initial bootstrap requires terminal replay');
    if (
      environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION !== undefined
      || environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING !== undefined
    ) fail('persistence key config is forbidden while terminal replay is disabled');
    if (identityVersionConfigured || identityKeyringConfigured) {
      fail('identity encryption key config is forbidden while terminal replay is disabled');
    }
    return Object.freeze({ enabled: false, mode });
  }

  const rawVersion = environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION ?? '';
  if (!/^[1-9][0-9]*$/u.test(rawVersion)) {
    fail('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION must be a positive integer');
  }
  const currentVersion = Number(rawVersion);
  if (!Number.isSafeInteger(currentVersion) || currentVersion > POSTGRES_INTEGER_MAX) {
    fail('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION exceeds PostgreSQL integer range');
  }
  const directUrl = environment.DIRECT_URL?.trim() ?? '';
  if (!directUrl) fail('DIRECT_URL is required');

  let decodedKeyring;
  try {
    decodedKeyring = JSON.parse(
      environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING ?? '',
    );
  } catch {
    fail('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING must be valid JSON');
  }
  if (!decodedKeyring || typeof decodedKeyring !== 'object' || Array.isArray(decodedKeyring)) {
    fail('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING must be an object');
  }
  const entries = Object.entries(decodedKeyring);
  if (entries.length < 1 || entries.length > MAX_KEYRING_SIZE) fail('keyring size is invalid');
  const keyVersions = [];
  const keyBindings = [];
  const uniqueSecrets = new Set();
  for (const [rawKeyVersion, secret] of entries) {
    if (!/^[1-9][0-9]*$/u.test(rawKeyVersion)) fail('keyring contains an invalid version');
    const keyVersion = Number(rawKeyVersion);
    if (!Number.isSafeInteger(keyVersion) || keyVersion > POSTGRES_INTEGER_MAX) {
      fail('keyring version exceeds PostgreSQL integer range');
    }
    if (
      typeof secret !== 'string'
      || !CANONICAL_SECRET.test(secret)
      || Buffer.from(secret, 'base64url').length !== 32
      || Buffer.from(secret, 'base64url').toString('base64url') !== secret
    ) fail('keyring contains a non-canonical secret');
    if (uniqueSecrets.has(secret)) fail('keyring reuses key material across versions');
    uniqueSecrets.add(secret);
    keyVersions.push(keyVersion);
    keyBindings.push(Object.freeze({
      version: keyVersion,
      fingerprint: createHash('sha256')
        .update(Buffer.from(secret, 'base64url'))
        .digest('hex'),
    }));
  }
  if (!keyVersions.includes(currentVersion)) fail('keyring does not contain current version');

  if (identityVersionConfigured !== identityKeyringConfigured) {
    fail('identity encryption key config must be complete');
  }
  if (initialBootstrapEnabled === 'true' && !identityVersionConfigured) {
    fail('identity encryption key config is required while initial bootstrap is enabled');
  }

  let identityCurrentVersion = null;
  const identityKeyVersions = [];
  const identityKeyBindings = [];
  const uniqueIdentitySecrets = new Set();
  if (identityVersionConfigured && identityKeyringConfigured) {
    const rawIdentityVersion =
      environment.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION;
    if (
      typeof rawIdentityVersion !== 'string'
      || !CANONICAL_IDENTITY_VERSION.test(rawIdentityVersion)
    ) fail('identity encryption key version must be a canonical positive integer');
    identityCurrentVersion = Number(rawIdentityVersion);
    if (
      !Number.isSafeInteger(identityCurrentVersion)
      || identityCurrentVersion > POSTGRES_INTEGER_MAX
    ) fail('identity encryption key version exceeds PostgreSQL integer range');

    const rawIdentityKeyring =
      environment.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING;
    if (
      typeof rawIdentityKeyring !== 'string'
      || rawIdentityKeyring.length < 1
      || rawIdentityKeyring.length > MAX_IDENTITY_KEYRING_JSON_LENGTH
    ) fail('identity encryption keyring size is invalid');
    let decodedIdentityKeyring;
    try {
      decodedIdentityKeyring = JSON.parse(rawIdentityKeyring);
    } catch {
      fail('identity encryption keyring must be valid JSON');
    }
    if (
      !decodedIdentityKeyring
      || typeof decodedIdentityKeyring !== 'object'
      || Array.isArray(decodedIdentityKeyring)
    ) fail('identity encryption keyring must be an object');
    const identityEntries = Object.entries(decodedIdentityKeyring);
    if (identityEntries.length < 1 || identityEntries.length > MAX_KEYRING_SIZE) {
      fail('identity encryption keyring size is invalid');
    }
    for (const [rawKeyVersion, secret] of identityEntries) {
      if (!CANONICAL_IDENTITY_VERSION.test(rawKeyVersion)) {
        fail('identity encryption keyring contains an invalid version');
      }
      const keyVersion = Number(rawKeyVersion);
      if (!Number.isSafeInteger(keyVersion) || keyVersion > POSTGRES_INTEGER_MAX) {
        fail('identity encryption keyring version exceeds PostgreSQL integer range');
      }
      if (
        typeof secret !== 'string'
        || !CANONICAL_SECRET.test(secret)
        || Buffer.from(secret, 'base64url').length !== 32
        || Buffer.from(secret, 'base64url').toString('base64url') !== secret
      ) fail('identity encryption keyring contains a non-canonical secret');
      if (uniqueIdentitySecrets.has(secret)) {
        fail('identity encryption keyring reuses key material across versions');
      }
      if (uniqueSecrets.has(secret)) {
        fail('identity encryption key material must be dedicated');
      }
      uniqueIdentitySecrets.add(secret);
      identityKeyVersions.push(keyVersion);
      identityKeyBindings.push(Object.freeze({
        version: keyVersion,
        fingerprint: createHash('sha256')
          .update(Buffer.from(secret, 'base64url'))
          .digest('hex'),
      }));
    }
    if (!identityKeyVersions.includes(identityCurrentVersion)) {
      fail('identity encryption keyring does not contain current version');
    }
  }

  const rawSubjectVersion = environment.BOB_LIVE_SUBJECT_KEY_VERSION ?? '1';
  if (!CANONICAL_SUBJECT_VERSION.test(rawSubjectVersion)) {
    fail('subject HMAC key version must be a canonical positive integer');
  }
  const subjectCurrentVersion = Number(rawSubjectVersion);
  if (
    !Number.isSafeInteger(subjectCurrentVersion)
    || subjectCurrentVersion > POSTGRES_INTEGER_MAX
  ) fail('subject HMAC key version exceeds PostgreSQL integer range');

  const rawSubjectKeyring = environment.BOB_LIVE_SUBJECT_HMAC_KEYRING;
  if (
    typeof rawSubjectKeyring !== 'string'
    || rawSubjectKeyring.length < 1
    || rawSubjectKeyring.length > MAX_SUBJECT_KEYRING_JSON_LENGTH
  ) fail('subject HMAC keyring size is invalid');
  let decodedSubjectKeyring;
  try {
    decodedSubjectKeyring = JSON.parse(rawSubjectKeyring);
  } catch {
    fail('subject HMAC keyring must be valid JSON');
  }
  if (
    !decodedSubjectKeyring
    || typeof decodedSubjectKeyring !== 'object'
    || Array.isArray(decodedSubjectKeyring)
    || Object.getPrototypeOf(decodedSubjectKeyring) !== Object.prototype
  ) fail('subject HMAC keyring must be an object');
  const subjectEntries = Object.entries(decodedSubjectKeyring);
  if (
    subjectEntries.length < 1
    || subjectEntries.length > MAX_SUBJECT_KEYRING_SIZE
  ) fail('subject HMAC keyring size is invalid');

  const uniqueSubjectSecrets = new Set();
  const subjectKeyVersions = [];
  const subjectKeyBindings = [];
  for (const [rawKeyVersion, secret] of subjectEntries) {
    if (!CANONICAL_SUBJECT_VERSION.test(rawKeyVersion)) {
      fail('subject HMAC keyring contains an invalid version');
    }
    const keyVersion = Number(rawKeyVersion);
    if (!Number.isSafeInteger(keyVersion) || keyVersion > POSTGRES_INTEGER_MAX) {
      fail('subject HMAC keyring version exceeds PostgreSQL integer range');
    }
    if (
      typeof secret !== 'string'
      || secret.length < 32
      || secret.length > 512
      || secret.includes('[')
      || secret.includes(']')
      || [...secret].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x21 || codePoint > 0x7e;
      })
    ) fail('subject HMAC keyring contains an invalid secret');
    if (uniqueSubjectSecrets.has(secret)) {
      fail('subject HMAC keyring reuses key material across versions');
    }
    if (uniqueSecrets.has(secret) || uniqueIdentitySecrets.has(secret)) {
      fail('subject HMAC key material must be dedicated');
    }
    uniqueSubjectSecrets.add(secret);
    subjectKeyVersions.push(keyVersion);
    subjectKeyBindings.push(Object.freeze({
      version: keyVersion,
      // Le runtime historique passe la chaîne telle quelle à createHmac. Ne jamais décoder,
      // normaliser ou ré-encoder : l'empreinte atteste exactement les octets UTF-8 déployés.
      fingerprint: createHash('sha256').update(secret, 'utf8').digest('hex'),
    }));
  }
  if (!subjectKeyVersions.includes(subjectCurrentVersion)) {
    fail('subject HMAC keyring does not contain current version');
  }
  const legacyCurrentSubjectSecret =
    environment.BOB_LIVE_SUBJECT_HMAC_SECRET
    ?? environment.OPENAI_REALTIME_SAFETY_SECRET
    ?? null;
  const configuredCurrentSubjectSecret = decodedSubjectKeyring[rawSubjectVersion];
  if (
    legacyCurrentSubjectSecret !== null
    && legacyCurrentSubjectSecret !== configuredCurrentSubjectSecret
  ) fail('legacy subject HMAC secret does not match current keyring version');

  return Object.freeze({
    enabled: true,
    mode,
    currentVersion,
    directUrl,
    keyVersions: Object.freeze(keyVersions.sort((left, right) => left - right)),
    keyBindings: Object.freeze(
      keyBindings.sort((left, right) => left.version - right.version),
    ),
    identityCurrentVersion,
    identityKeyVersions: Object.freeze(
      identityKeyVersions.sort((left, right) => left - right),
    ),
    identityKeyBindings: Object.freeze(
      identityKeyBindings.sort((left, right) => left.version - right.version),
    ),
    subjectCurrentVersion,
    subjectKeyVersions: Object.freeze(
      subjectKeyVersions.sort((left, right) => left - right),
    ),
    subjectKeyBindings: Object.freeze(
      subjectKeyBindings.sort((left, right) => left.version - right.version),
    ),
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

function configuredBinding(config, version) {
  return config.keyBindings?.find((binding) => binding.version === version) ?? null;
}

function configuredIdentityBinding(config, version) {
  return config.identityKeyBindings?.find((binding) => binding.version === version) ?? null;
}

function configuredSubjectBinding(config, version) {
  return config.subjectKeyBindings?.find((binding) => binding.version === version) ?? null;
}

export async function manageMistralConversationKeyVersion(config, prisma) {
  if (!config.enabled) return Object.freeze({ status: 'disabled' });

  return prisma.$transaction(async (tx) => {
    // `$queryRaw` ne peut pas désérialiser le pseudo-type PostgreSQL `void` renvoyé par
    // pg_advisory_xact_lock. `$executeRaw` conserve le verrou transactionnel sans matérialiser
    // cette colonne et reste paramétré par le tag Prisma.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${KEY_SPACE}, 0))
    `;
    // Ordre canonique pour tout rituel qui touche les deux familles : persistance puis identité.
    // Le second lock ferme la course snapshot/INSERT avec les anciens writers bootstrap.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${IDENTITY_KEY_SPACE}, 0))
    `;
    // Le HMAC sujet est le dernier domaine de l'ordre global. Son verrou protège à la fois le
    // snapshot des preuves historiques et la plage de versions autorisées aux nouveaux writers.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${SUBJECT_KEY_SPACE}, 0))
    `;
    const retained = await tx.$queryRaw`
      SELECT DISTINCT version
        FROM (
          SELECT "encryptionKeyVersion" AS version
            FROM realtime_mistral_conversation_outbox
          UNION
          SELECT "proofKeyVersion" AS version
            FROM realtime_mistral_conversation_commands
        ) AS retained_versions
       ORDER BY version
    `;
    // Les r2 de réconciliation sont re-dérivés avec leur version d'origine après une perte de
    // réponse. Tant que la ligne n'a pas été purgée, retirer cette matière rendrait ce retry
    // déterministe impossible. Aucun filtre state/expiry : la rétention SQL est l'autorité.
    const retainedReconciliation = await tx.$queryRaw`
      SELECT DISTINCT "reconciliationKeyVersion" AS version
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "reconciliationKeyVersion" IS NOT NULL
       ORDER BY "reconciliationKeyVersion"
    `;
    // Une preuve bootstrap non purgée doit rester déchiffrable même en mode drain. Ce snapshot
    // est lu sous le même verrou exclusif que stage/retire pour fermer toute fenêtre de release.
    const retainedIdentity = await tx.$queryRaw`
      SELECT DISTINCT "identityEncryptionKeyVersion" AS version
        FROM realtime_mistral_conversation_bootstrap_tickets
       ORDER BY "identityEncryptionKeyVersion"
    `;
    const identityRanges = await tx.$queryRaw`
      SELECT "minimumVersion", "highestVersion"
        FROM realtime_mistral_conversation_identity_key_version_floors
       WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
    `;
    if (identityRanges.length > 1) {
      fail('database returned multiple durable identity encryption ranges');
    }
    const identityRange = identityRanges[0] ?? null;
    if (identityRange !== null && !validRange(identityRange)) {
      fail('database returned an invalid identity encryption range');
    }
    for (const row of retainedIdentity) {
      if (
        !Number.isInteger(row.version)
        || row.version < 1
        || row.version > POSTGRES_INTEGER_MAX
      ) fail('database returned an invalid retained identity encryption version');
    }
    if (identityRange === null && retainedIdentity.length > 0) {
      fail('durable identity encryption range is missing for retained bootstrap versions');
    }
    if (retainedIdentity.length > 0 && config.identityKeyVersions.length === 0) {
      fail('identity encryption keyring is required for retained bootstrap versions');
    }
    if (identityRange !== null && config.identityKeyVersions.length === 0) {
      fail('identity encryption keyring is required for the durable identity range');
    }
    if (
      retainedIdentity.some((row) => !config.identityKeyVersions.includes(row.version))
    ) {
      fail('identity encryption keyring does not cover every retained bootstrap version');
    }
    const retainedSubject = await tx.$queryRaw`
      SELECT DISTINCT version
        FROM (
          SELECT "subjectKeyVersion" AS version
            FROM realtime_mistral_conversation_bootstrap_tickets
          UNION
          SELECT "subjectKeyVersion" AS version
            FROM realtime_mistral_conversation_missions
          UNION
          SELECT "subjectKeyVersion" AS version
            FROM realtime_mistral_conversation_terminal_receipts
        ) AS retained_subject_versions
       ORDER BY version
    `;
    const subjectRanges = await tx.$queryRaw`
      SELECT "minimumVersion", "highestVersion"
        FROM realtime_mistral_conversation_key_version_floors
       WHERE "keySpace" = ${SUBJECT_KEY_SPACE}
    `;
    if (subjectRanges.length > 1) {
      fail('database returned multiple durable subject HMAC ranges');
    }
    const subjectRange = subjectRanges[0] ?? null;
    if (subjectRange !== null && !validRange(subjectRange)) {
      fail('database returned an invalid subject HMAC range');
    }
    for (const row of retainedSubject) {
      if (
        !Number.isInteger(row.version)
        || row.version < 1
        || row.version > POSTGRES_INTEGER_MAX
      ) fail('database returned an invalid retained subject HMAC version');
    }
    if (subjectRange === null && retainedSubject.length > 0) {
      fail('durable subject HMAC range is missing for retained subject versions');
    }
    if (
      retainedSubject.some((row) => !config.subjectKeyVersions.includes(row.version))
    ) fail('subject HMAC keyring does not cover every retained subject version');

    const existingRanges = await tx.$queryRaw`
      SELECT "minimumVersion", "highestVersion"
        FROM realtime_mistral_conversation_key_version_floors
       WHERE "keySpace" = ${KEY_SPACE}
    `;
    if (existingRanges.length > 1) fail('database returned multiple durable ranges');
    const existingRange = existingRanges[0] ?? null;
    if (existingRange !== null && !validRange(existingRange)) {
      fail('database returned an invalid existing range');
    }
    if (
      existingRange === null
      && (retained.length > 0 || retainedReconciliation.length > 0)
    ) {
      fail('durable range is missing for retained persistence versions');
    }

    const requiredVersions = new Set([config.currentVersion]);
    for (const row of [...retained, ...retainedReconciliation]) {
      if (!Number.isInteger(row.version)) {
        fail('database returned an invalid retained persistence version');
      }
      requiredVersions.add(row.version);
    }
    if (existingRange !== null) {
      requiredVersions.add(existingRange.minimumVersion);
      requiredVersions.add(existingRange.highestVersion);
    }

    const retainedReconciliationVersions = new Set(
      retainedReconciliation.map((row) => row.version),
    );
    if (
      config.mode === 'retire'
      && existingRange !== null
      && existingRange.minimumVersion < config.currentVersion
      && retainedReconciliationVersions.has(existingRange.minimumVersion)
    ) {
      fail(
        `cannot retire persistence version ${existingRange.minimumVersion} while a reconciliation ticket retains it`,
      );
    }

    const retainedIdentityVersions = new Set(retainedIdentity.map((row) => row.version));
    if (
      config.mode === 'retire'
      && identityRange !== null
      && config.identityCurrentVersion !== null
      && identityRange.minimumVersion < config.identityCurrentVersion
      && retainedIdentityVersions.has(identityRange.minimumVersion)
    ) {
      fail(
        `cannot retire identity encryption version ${identityRange.minimumVersion} while a bootstrap ticket retains it`,
      );
    }

    let requiredIdentityBindings = [];
    if (config.identityCurrentVersion !== null) {
      const requiredIdentityVersions = new Set([config.identityCurrentVersion]);
      for (const row of retainedIdentity) requiredIdentityVersions.add(row.version);
      if (identityRange !== null) {
        requiredIdentityVersions.add(identityRange.minimumVersion);
        requiredIdentityVersions.add(identityRange.highestVersion);
      }
      requiredIdentityBindings = [...requiredIdentityVersions]
        .sort((left, right) => left - right)
        .map((version) => {
          const binding = configuredIdentityBinding(config, version);
          if (!binding || !config.identityKeyVersions.includes(version)) {
            fail('identity keyring does not cover every admitted or retained identity version');
          }
          return binding;
        });
    }

    const requiredBindings = [...requiredVersions]
      .sort((left, right) => left - right)
      .map((version) => {
        const binding = configuredBinding(config, version);
        if (!binding || !config.keyVersions.includes(version)) {
          fail('keyring does not cover every admitted or retained persistence version');
        }
        return binding;
      });

    const requiredSubjectVersions = new Set([config.subjectCurrentVersion]);
    for (const row of retainedSubject) requiredSubjectVersions.add(row.version);
    if (subjectRange !== null) {
      requiredSubjectVersions.add(subjectRange.minimumVersion);
      requiredSubjectVersions.add(subjectRange.highestVersion);
    }
    const requiredSubjectBindings = [...requiredSubjectVersions]
      .sort((left, right) => left - right)
      .map((version) => {
        const binding = configuredSubjectBinding(config, version);
        if (!binding || !config.subjectKeyVersions.includes(version)) {
          fail('subject HMAC keyring does not cover every admitted or retained subject version');
        }
        return binding;
      });

    for (const binding of requiredBindings) {
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (${KEY_SPACE}, ${binding.version}, ${binding.fingerprint})
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const committedBindings = await tx.$queryRaw`
        SELECT "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings
         WHERE "keySpace" = ${KEY_SPACE}
           AND "keyVersion" = ${binding.version}
      `;
      if (
        committedBindings.length !== 1
        || committedBindings[0]?.keyFingerprint !== binding.fingerprint
      ) {
        fail(`key material changed for persistence version ${binding.version}`);
      }
    }

    for (const binding of requiredIdentityBindings) {
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_identity_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (${IDENTITY_KEY_SPACE}, ${binding.version}, ${binding.fingerprint})
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const committedBindings = await tx.$queryRaw`
        SELECT "keyFingerprint"
          FROM realtime_mistral_conversation_identity_key_bindings
         WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
           AND "keyVersion" = ${binding.version}
      `;
      if (
        committedBindings.length !== 1
        || committedBindings[0]?.keyFingerprint !== binding.fingerprint
      ) {
        fail(`key material changed for identity encryption version ${binding.version}`);
      }
    }

    for (const binding of requiredSubjectBindings) {
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (${SUBJECT_KEY_SPACE}, ${binding.version}, ${binding.fingerprint})
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const committedBindings = await tx.$queryRaw`
        SELECT "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings
         WHERE "keySpace" = ${SUBJECT_KEY_SPACE}
           AND "keyVersion" = ${binding.version}
      `;
      if (
        committedBindings.length !== 1
        || committedBindings[0]?.keyFingerprint !== binding.fingerprint
      ) fail(`key material changed for subject HMAC version ${binding.version}`);
    }

    let rows;
    if (config.mode === 'stage') {
      rows = await tx.$queryRaw`
        INSERT INTO realtime_mistral_conversation_key_version_floors (
          "keySpace",
          "minimumVersion",
          "highestVersion"
        )
        VALUES (${KEY_SPACE}, ${config.currentVersion}, ${config.currentVersion})
        ON CONFLICT ("keySpace") DO UPDATE
        SET "highestVersion" = CASE
          WHEN realtime_mistral_conversation_key_version_floors."highestVersion"
               < EXCLUDED."highestVersion"
            THEN EXCLUDED."highestVersion"
          ELSE realtime_mistral_conversation_key_version_floors."highestVersion"
        END
        WHERE ${config.currentVersion} BETWEEN
                realtime_mistral_conversation_key_version_floors."minimumVersion"
                AND realtime_mistral_conversation_key_version_floors."highestVersion"
           OR (
             realtime_mistral_conversation_key_version_floors."minimumVersion"
               = realtime_mistral_conversation_key_version_floors."highestVersion"
             AND ${config.currentVersion}::bigint
               = realtime_mistral_conversation_key_version_floors."highestVersion"::bigint + 1
           )
        RETURNING "minimumVersion", "highestVersion"
      `;
    } else {
      rows = await tx.$queryRaw`
        UPDATE realtime_mistral_conversation_key_version_floors
           SET "minimumVersion" = GREATEST("minimumVersion", ${config.currentVersion})
         WHERE "keySpace" = ${KEY_SPACE}
           AND (
             ("minimumVersion" = ${config.currentVersion}
               AND "highestVersion" = ${config.currentVersion})
             OR (
               "minimumVersion"::bigint + 1 = ${config.currentVersion}::bigint
               AND "highestVersion" = ${config.currentVersion}
             )
           )
        RETURNING "minimumVersion", "highestVersion"
      `;
    }

    const range = rows[0];
    if (rows.length !== 1 || !range) fail(`${config.mode} did not return one durable range`);
    if (!validRange(range)) fail('database returned an invalid range');
    if (
      !config.keyVersions.includes(range.minimumVersion)
      || !config.keyVersions.includes(range.highestVersion)
    ) fail('keyring does not cover the resulting admitted persistence range');
    if (
      config.currentVersion < range.minimumVersion
      || config.currentVersion > range.highestVersion
    ) fail(`version ${config.currentVersion} is outside the durable range`);
    if (config.mode === 'retire' && range.minimumVersion !== config.currentVersion) {
      fail(`retirement did not reach version ${config.currentVersion}`);
    }

    if (config.identityCurrentVersion !== null) {
      let identityRows;
      if (config.mode === 'stage') {
        identityRows = await tx.$queryRaw`
          INSERT INTO realtime_mistral_conversation_identity_key_version_floors (
            "keySpace",
            "minimumVersion",
            "highestVersion"
          )
          VALUES (
            ${IDENTITY_KEY_SPACE},
            ${config.identityCurrentVersion},
            ${config.identityCurrentVersion}
          )
          ON CONFLICT ("keySpace") DO UPDATE
          SET "highestVersion" = CASE
            WHEN realtime_mistral_conversation_identity_key_version_floors."highestVersion"
                 < EXCLUDED."highestVersion"
              THEN EXCLUDED."highestVersion"
            ELSE realtime_mistral_conversation_identity_key_version_floors."highestVersion"
          END
          WHERE ${config.identityCurrentVersion} BETWEEN
                  realtime_mistral_conversation_identity_key_version_floors."minimumVersion"
                  AND realtime_mistral_conversation_identity_key_version_floors."highestVersion"
             OR (
               realtime_mistral_conversation_identity_key_version_floors."minimumVersion"
                 = realtime_mistral_conversation_identity_key_version_floors."highestVersion"
               AND ${config.identityCurrentVersion}::bigint
                 = realtime_mistral_conversation_identity_key_version_floors."highestVersion"::bigint + 1
             )
          RETURNING "minimumVersion", "highestVersion"
        `;
      } else {
        identityRows = await tx.$queryRaw`
          UPDATE realtime_mistral_conversation_identity_key_version_floors
             SET "minimumVersion" = GREATEST(
               "minimumVersion", ${config.identityCurrentVersion}
             )
           WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
             AND (
               ("minimumVersion" = ${config.identityCurrentVersion}
                 AND "highestVersion" = ${config.identityCurrentVersion})
               OR (
                 "minimumVersion"::bigint + 1 = ${config.identityCurrentVersion}::bigint
                 AND "highestVersion" = ${config.identityCurrentVersion}
               )
             )
          RETURNING "minimumVersion", "highestVersion"
        `;
      }

      const resultingIdentityRange = identityRows[0];
      if (identityRows.length !== 1 || !resultingIdentityRange) {
        fail(`identity ${config.mode} did not return one durable range`);
      }
      if (!validRange(resultingIdentityRange)) {
        fail('database returned an invalid resulting identity encryption range');
      }
      if (
        !config.identityKeyVersions.includes(resultingIdentityRange.minimumVersion)
        || !config.identityKeyVersions.includes(resultingIdentityRange.highestVersion)
      ) fail('identity keyring does not cover the resulting admitted identity range');
      if (
        config.identityCurrentVersion < resultingIdentityRange.minimumVersion
        || config.identityCurrentVersion > resultingIdentityRange.highestVersion
      ) {
        fail(
          `identity version ${config.identityCurrentVersion} is outside the durable identity range`,
        );
      }
      if (
        config.mode === 'retire'
        && (
          resultingIdentityRange.minimumVersion !== config.identityCurrentVersion
          || resultingIdentityRange.highestVersion !== config.identityCurrentVersion
        )
      ) {
        fail(`identity retirement did not reach version ${config.identityCurrentVersion}`);
      }
    }

    let subjectRows;
    if (config.mode === 'stage') {
      subjectRows = await tx.$queryRaw`
        INSERT INTO realtime_mistral_conversation_key_version_floors (
          "keySpace",
          "minimumVersion",
          "highestVersion"
        )
        VALUES (
          ${SUBJECT_KEY_SPACE},
          ${config.subjectCurrentVersion},
          ${config.subjectCurrentVersion}
        )
        ON CONFLICT ("keySpace") DO UPDATE
        SET "highestVersion" = CASE
          WHEN realtime_mistral_conversation_key_version_floors."highestVersion"
               < EXCLUDED."highestVersion"
            THEN EXCLUDED."highestVersion"
          ELSE realtime_mistral_conversation_key_version_floors."highestVersion"
        END
        WHERE ${config.subjectCurrentVersion} BETWEEN
                realtime_mistral_conversation_key_version_floors."minimumVersion"
                AND realtime_mistral_conversation_key_version_floors."highestVersion"
           OR (
             realtime_mistral_conversation_key_version_floors."minimumVersion"
               = realtime_mistral_conversation_key_version_floors."highestVersion"
             AND ${config.subjectCurrentVersion}::bigint
               = realtime_mistral_conversation_key_version_floors."highestVersion"::bigint + 1
           )
        RETURNING "minimumVersion", "highestVersion"
      `;
    } else {
      subjectRows = await tx.$queryRaw`
        UPDATE realtime_mistral_conversation_key_version_floors
           SET "minimumVersion" = GREATEST(
             "minimumVersion", ${config.subjectCurrentVersion}
           )
         WHERE "keySpace" = ${SUBJECT_KEY_SPACE}
           AND (
             ("minimumVersion" = ${config.subjectCurrentVersion}
               AND "highestVersion" = ${config.subjectCurrentVersion})
             OR (
               "minimumVersion"::bigint + 1 = ${config.subjectCurrentVersion}::bigint
               AND "highestVersion" = ${config.subjectCurrentVersion}
             )
           )
        RETURNING "minimumVersion", "highestVersion"
      `;
    }

    const resultingSubjectRange = subjectRows[0];
    if (subjectRows.length !== 1 || !resultingSubjectRange) {
      fail(`subject HMAC ${config.mode} did not return one durable range`);
    }
    if (!validRange(resultingSubjectRange)) {
      fail('database returned an invalid resulting subject HMAC range');
    }
    if (
      !config.subjectKeyVersions.includes(resultingSubjectRange.minimumVersion)
      || !config.subjectKeyVersions.includes(resultingSubjectRange.highestVersion)
    ) fail('subject HMAC keyring does not cover the resulting admitted subject range');
    if (
      config.subjectCurrentVersion < resultingSubjectRange.minimumVersion
      || config.subjectCurrentVersion > resultingSubjectRange.highestVersion
    ) {
      fail(
        `subject HMAC version ${config.subjectCurrentVersion} is outside the durable subject range`,
      );
    }
    if (
      config.mode === 'retire'
      && (
        resultingSubjectRange.minimumVersion !== config.subjectCurrentVersion
        || resultingSubjectRange.highestVersion !== config.subjectCurrentVersion
      )
    ) fail(`subject HMAC retirement did not reach version ${config.subjectCurrentVersion}`);

    return Object.freeze({
      status: config.mode === 'stage' ? 'staged' : 'retired',
      minimumVersion: range.minimumVersion,
      highestVersion: range.highestVersion,
    });
  });
}

async function main() {
  let prisma;
  try {
    const config = parseMistralKeyVersionOperation(process.argv[2]);
    if (!config.enabled) {
      console.log(`mistral-key-version:${config.mode}:disabled`);
      return;
    }
    prisma = new PrismaClient({ datasourceUrl: config.directUrl });
    await prisma.$connect();
    const result = await manageMistralConversationKeyVersion(config, prisma);
    console.log(
      `mistral-key-version:${result.status}:${result.minimumVersion}-${result.highestVersion}`,
    );
  } catch {
    // Ne jamais imprimer DIRECT_URL, les clés ou un diagnostic Prisma contenant la connexion.
    console.error('mistral-key-version:error');
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith('manage-mistral-conversation-key-version.mjs')) {
  await main();
}
