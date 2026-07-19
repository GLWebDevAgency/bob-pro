#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const KEY_SPACE = 'mistral-conversation-persistence-v1';
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_KEYRING_SIZE = 8;
const CANONICAL_SECRET = /^[A-Za-z0-9_-]{43}$/u;

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
  if (enabled === 'false') {
    if (
      environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION !== undefined
      || environment.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING !== undefined
    ) fail('persistence key config is forbidden while terminal replay is disabled');
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

  return Object.freeze({
    enabled: true,
    mode,
    currentVersion,
    directUrl,
    keyVersions: Object.freeze(keyVersions.sort((left, right) => left - right)),
    keyBindings: Object.freeze(
      keyBindings.sort((left, right) => left.version - right.version),
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

export async function manageMistralConversationKeyVersion(config, prisma) {
  if (!config.enabled) return Object.freeze({ status: 'disabled' });

  return prisma.$transaction(async (tx) => {
    // `$queryRaw` ne peut pas désérialiser le pseudo-type PostgreSQL `void` renvoyé par
    // pg_advisory_xact_lock. `$executeRaw` conserve le verrou transactionnel sans matérialiser
    // cette colonne et reste paramétré par le tag Prisma.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${KEY_SPACE}, 0))
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
    if (existingRange === null && retained.length > 0) {
      fail('durable range is missing for retained persistence versions');
    }

    const requiredVersions = new Set([config.currentVersion]);
    for (const row of retained) {
      if (!Number.isInteger(row.version)) {
        fail('database returned an invalid retained persistence version');
      }
      requiredVersions.add(row.version);
    }
    if (existingRange !== null) {
      requiredVersions.add(existingRange.minimumVersion);
      requiredVersions.add(existingRange.highestVersion);
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
