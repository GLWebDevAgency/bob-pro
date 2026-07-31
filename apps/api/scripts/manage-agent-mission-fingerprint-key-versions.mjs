import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const KEY_SPACE = 'bob-agent-mission-fingerprint-hmac-v1';
const DOMAIN = Buffer.from('bob.agent-mission.fingerprint-hmac-key.v1\0', 'utf8');
const VERSION = /^[1-9][0-9]{0,9}$/u;
const BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
const DEDICATED_SCALAR_SECRET_NAMES = Object.freeze([
  'BOB_LIVE_SUBJECT_HMAC_SECRET',
  'OPENAI_REALTIME_SAFETY_SECRET',
  'BOB_LIVE_PROOF_SECRET',
  'OPENAI_REALTIME_PROOF_SECRET',
  'BOB_LIVE_USAGE_HMAC_SECRET',
  'BOB_LIVE_CONTROL_ENCRYPTION_SECRET',
  'OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET',
  'BOB_LIVE_LOCAL_AUDIT_TOKEN',
]);
const DEDICATED_KEYRING_SECRET_NAMES = Object.freeze([
  'BOB_LIVE_SUBJECT_HMAC_KEYRING',
  'BOB_LIVE_PROOF_KEYRING',
  'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
  'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
]);

class AgentMissionFingerprintKeyOperationError extends Error {
  constructor(message, code = 'operation-rejected') {
    super(`AgentMission fingerprint key operation failed: ${message}`);
    this.name = 'AgentMissionFingerprintKeyOperationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new AgentMissionFingerprintKeyOperationError(message, code);
}

function fingerprint(secret) {
  if (!BASE64URL.test(secret)) {
    fail('keyring contains non-canonical key material');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== secret) {
    fail('keyring contains non-canonical key material');
  }
  return createHash('sha256').update(DOMAIN).update(decoded).digest('hex');
}

function assertDedicatedMissionSecrets(environment, missionSecrets) {
  const otherSecrets = new Set();
  for (const name of DEDICATED_SCALAR_SECRET_NAMES) {
    const value = environment[name];
    if (value !== undefined) {
      if (typeof value !== 'string') fail('Bob Live dedicated secret registry is invalid');
      otherSecrets.add(value);
    }
  }
  for (const name of DEDICATED_KEYRING_SECRET_NAMES) {
    const raw = environment[name];
    if (raw === undefined) continue;
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw, 'utf8') < 2 ||
      Buffer.byteLength(raw, 'utf8') > 16_384
    )
      fail('Bob Live dedicated secret registry is invalid');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('Bob Live dedicated secret registry is invalid');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    )
      fail('Bob Live dedicated secret registry is invalid');
    const values = Object.values(parsed);
    if (
      values.length < 1 ||
      values.length > 32 ||
      values.some((value) => typeof value !== 'string')
    )
      fail('Bob Live dedicated secret registry is invalid');
    for (const value of values) otherSecrets.add(value);
  }
  if (missionSecrets.some((secret) => otherSecrets.has(secret))) {
    fail('AgentMission key material must be dedicated from every Bob Live secret');
  }
}

export function parseAgentMissionFingerprintKeyOperation(mode, environment = process.env) {
  if (mode !== 'stage' && mode !== 'retire') {
    fail('operation must be stage or retire');
  }
  const master = environment.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED;
  const rawVersion = environment.BOB_AGENT_MISSION_HMAC_KEY_VERSION;
  const rawKeyring = environment.BOB_AGENT_MISSION_HMAC_KEYRING;
  if (master !== undefined && master !== 'true' && master !== 'false') {
    fail('BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED must be true or false');
  }
  const directUrl = environment.DIRECT_URL;
  if (typeof directUrl !== 'string' || directUrl.trim().length < 1) {
    fail('DIRECT_URL is required');
  }
  if (master !== 'true') {
    if (rawVersion !== undefined || rawKeyring !== undefined) {
      fail('disabled master requires the fingerprint keyring block to be absent');
    }
    return Object.freeze({ enabled: false, mode });
  }
  const bobLiveEnabled = environment.BOB_LIVE_ENABLED ?? environment.OPENAI_REALTIME_ENABLED;
  const bobLiveProvider = environment.BOB_LIVE_PROVIDER ?? 'openai';
  if (bobLiveEnabled !== 'true' || bobLiveProvider !== 'openai') {
    fail('enabled AgentMission requires Bob Live with the OpenAI provider');
  }
  if (rawVersion === undefined || rawKeyring === undefined) {
    fail('enabled master requires the complete fingerprint keyring block');
  }
  if (Buffer.byteLength(rawKeyring, 'utf8') > 16_384) {
    fail('keyring exceeds its bounded representation');
  }
  if (!VERSION.test(rawVersion)) fail('current key version is invalid');
  const currentVersion = Number(rawVersion);
  if (!Number.isSafeInteger(currentVersion) || currentVersion > 2_147_483_647) {
    fail('current key version is invalid');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawKeyring);
  } catch {
    fail('keyring must be valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  )
    fail('keyring must be an object');
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 32) {
    fail('keyring must contain between 1 and 32 keys');
  }
  const seenSecrets = new Set();
  const bindings = entries
    .map(([rawKeyVersion, secret]) => {
      if (
        !VERSION.test(rawKeyVersion) ||
        !Number.isSafeInteger(Number(rawKeyVersion)) ||
        Number(rawKeyVersion) > 2_147_483_647 ||
        typeof secret !== 'string' ||
        seenSecrets.has(secret)
      )
        fail('keyring contains an invalid or reused version/material');
      seenSecrets.add(secret);
      return Object.freeze({
        version: Number(rawKeyVersion),
        fingerprint: fingerprint(secret),
      });
    })
    .sort((left, right) => left.version - right.version);
  assertDedicatedMissionSecrets(
    environment,
    entries.map(([, secret]) => secret),
  );
  if (!bindings.some(({ version }) => version === currentVersion)) {
    fail('current key version is absent from the keyring');
  }
  return Object.freeze({
    enabled: true,
    mode,
    currentVersion,
    bindings: Object.freeze(bindings),
  });
}

function assertCanonicalReadinessRows(rows, configuredVersionCount) {
  if (
    !Array.isArray(rows) ||
    rows.length < configuredVersionCount ||
    rows.length > 65 ||
    rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row)) ||
    new Set(rows.map(({ keyVersion }) => keyVersion)).size !== rows.length
  )
    fail('readiness returned an invalid row set');
  let floor = null;
  let floorObserved = false;
  let retainedCount = 0;
  for (const row of rows) {
    if (
      !Number.isInteger(row.keyVersion) ||
      row.keyVersion < 1 ||
      row.keyVersion > 2_147_483_647 ||
      (row.keyFingerprint !== null && !/^[a-f0-9]{64}$/u.test(row.keyFingerprint)) ||
      typeof row.retained !== 'boolean' ||
      !(
        (row.minimumWriterVersion === null &&
          row.highestWriterVersion === null &&
          row.writerEnabled === null) ||
        (Number.isInteger(row.minimumWriterVersion) &&
          Number.isInteger(row.highestWriterVersion) &&
          typeof row.writerEnabled === 'boolean' &&
          row.minimumWriterVersion >= 1 &&
          row.highestWriterVersion >= row.minimumWriterVersion &&
          row.highestWriterVersion <= row.minimumWriterVersion + 1)
      )
    )
      fail('readiness returned a non-canonical binding or floor');
    if (row.retained) retainedCount += 1;
    if (retainedCount > 32) fail('more than 32 fingerprint versions remain retained');
    const rowFloor =
      row.minimumWriterVersion === null
        ? null
        : {
            minimumWriterVersion: row.minimumWriterVersion,
            highestWriterVersion: row.highestWriterVersion,
            writerEnabled: row.writerEnabled,
          };
    if (!floorObserved) {
      floor = rowFloor;
      floorObserved = true;
    } else if (
      (floor === null) !== (rowFloor === null) ||
      (floor !== null &&
        rowFloor !== null &&
        (floor.minimumWriterVersion !== rowFloor.minimumWriterVersion ||
          floor.highestWriterVersion !== rowFloor.highestWriterVersion ||
          floor.writerEnabled !== rowFloor.writerEnabled))
    )
      fail('readiness returned inconsistent writer floors');
  }
  return floor;
}

function assertNoRetainedUnboundFingerprintVersions(rows, config) {
  assertCanonicalReadinessRows(rows, config.bindings.length);
  const unboundRetained = rows.find(
    ({ retained, keyFingerprint }) => retained && keyFingerprint === null,
  );
  if (unboundRetained !== undefined) {
    fail(
      `retained version ${unboundRetained.keyVersion} predates its fingerprint binding`,
      'retained-key-unbound',
    );
  }
}

function assertReadinessRows(rows, config) {
  const floor = assertCanonicalReadinessRows(rows, config.bindings.length);
  const configured = new Map(
    config.bindings.map(({ version, fingerprint: keyFingerprint }) => [version, keyFingerprint]),
  );
  for (const row of rows) {
    if (!configured.has(row.keyVersion) && row.retained) {
      fail(`keyring does not cover retained version ${row.keyVersion}`, 'retained-key-missing');
    }
    if (configured.has(row.keyVersion) && configured.get(row.keyVersion) !== row.keyFingerprint)
      fail(`version ${row.keyVersion} material mismatch`);
  }
  for (const binding of config.bindings) {
    const row = rows.find(({ keyVersion }) => keyVersion === binding.version);
    if (row?.keyFingerprint !== binding.fingerprint) {
      fail(`version ${binding.version} material mismatch`);
    }
  }
  return floor;
}

async function queryReadinessUnderAuthority(transaction, config) {
  await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_agent_mission_fingerprint_readiness');
  const rows = await transaction.$queryRawUnsafe(
    `SELECT "keyVersion",
            "keyFingerprint",
            retained,
            "minimumWriterVersion",
            "highestWriterVersion",
            "writerEnabled"
       FROM public.agent_mission_fingerprint_key_readiness($1::INTEGER[])
      ORDER BY "keyVersion"`,
    config.bindings.map(({ version }) => version),
  );
  await transaction.$executeRawUnsafe('RESET ROLE');
  return rows;
}

async function assertNoRetainedUnboundFingerprintVersionsUnderAuthority(transaction, config) {
  const rows = await queryReadinessUnderAuthority(transaction, config);
  assertNoRetainedUnboundFingerprintVersions(rows, config);
}

async function readReadinessUnderAuthority(transaction, config) {
  return assertReadinessRows(await queryReadinessUnderAuthority(transaction, config), config);
}

async function assertClosedAndDrained(transaction) {
  await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_realtime_capacity');
  const rows = await transaction.$queryRawUnsafe(
    `SELECT mode, "usedSessions"
       FROM public.realtime_global_capacity
      WHERE id = 1
      FOR SHARE`,
  );
  await transaction.$executeRawUnsafe('RESET ROLE');
  if (rows.length !== 1 || rows[0]?.mode !== 'closed' || rows[0]?.usedSessions !== 0)
    fail(
      'retire requires Bob Live capacity closed with zero sessions',
      'capacity-not-closed-and-drained',
    );
}

export async function manageAgentMissionFingerprintKeyVersions(config, prisma) {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL search_path = pg_catalog');
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '40s'");
      await transaction.$executeRaw`
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(${KEY_SPACE}, 0)
      )
    `;
      if (!config.enabled) {
        const floors = await transaction.$queryRaw`
        SELECT "minimumWriterVersion", "highestWriterVersion", "writerEnabled"
          FROM public.agent_mission_fingerprint_key_version_floors
         WHERE "keySpace" = ${KEY_SPACE}
      `;
        if (
          floors.length > 1 ||
          (floors.length === 1 &&
            (!Number.isInteger(floors[0]?.minimumWriterVersion) ||
              !Number.isInteger(floors[0]?.highestWriterVersion) ||
              typeof floors[0]?.writerEnabled !== 'boolean'))
        )
          fail('disabled master observed an invalid writer floor');
        if (floors[0]?.writerEnabled === true) {
          await assertClosedAndDrained(transaction);
          await transaction.$executeRaw`
          UPDATE public.agent_mission_fingerprint_key_version_floors
             SET "writerEnabled" = FALSE
           WHERE "keySpace" = ${KEY_SPACE}
             AND "minimumWriterVersion" = ${floors[0].minimumWriterVersion}
             AND "highestWriterVersion" = ${floors[0].highestWriterVersion}
             AND "writerEnabled" = TRUE
        `;
          const disabledFloors = await transaction.$queryRaw`
          SELECT "writerEnabled"
            FROM public.agent_mission_fingerprint_key_version_floors
           WHERE "keySpace" = ${KEY_SPACE}
        `;
          if (disabledFloors.length !== 1 || disabledFloors[0]?.writerEnabled !== false)
            fail('disabled master did not commit the writer fence');
        }
        return Object.freeze({ status: 'disabled' });
      }
      // Le trigger writer, provisionné avant ce manager, prend le même verrou en partagé.
      // Sous notre verrou exclusif, cette lecture voit donc tous les events déjà commités et
      // aucun nouvel event ne peut arriver avant le commit du registre + floor. Une version
      // historique sans binding durable est refusée avant le premier INSERT : le déploiement
      // ne peut jamais inventer rétroactivement le matériau qui aurait signé ces events.
      await assertNoRetainedUnboundFingerprintVersionsUnderAuthority(transaction, config);
      for (const binding of config.bindings) {
        await transaction.$executeRaw`
        INSERT INTO public.agent_mission_fingerprint_key_bindings (
          "keyVersion",
          "keyFingerprint"
        ) VALUES (${binding.version}, ${binding.fingerprint})
        ON CONFLICT ("keyVersion") DO NOTHING
      `;
        const rows = await transaction.$queryRaw`
        SELECT "keyFingerprint"::text AS "keyFingerprint"
          FROM public.agent_mission_fingerprint_key_bindings
         WHERE "keyVersion" = ${binding.version}
      `;
        if (rows.length !== 1 || rows[0]?.keyFingerprint !== binding.fingerprint) {
          fail(`version ${binding.version} material mismatch`, 'binding-material-mismatch');
        }
      }
      let floor = await readReadinessUnderAuthority(transaction, config);
      const configuredVersions = new Set(config.bindings.map(({ version }) => version));
      let expectedFloor;
      if (config.mode === 'stage') {
        if (floor !== null && !floor.writerEnabled) {
          await transaction.$executeRaw`
          UPDATE public.agent_mission_fingerprint_key_version_floors
             SET "writerEnabled" = TRUE
           WHERE "keySpace" = ${KEY_SPACE}
             AND "minimumWriterVersion" = ${floor.minimumWriterVersion}
             AND "highestWriterVersion" = ${floor.highestWriterVersion}
             AND "writerEnabled" = FALSE
        `;
          floor = { ...floor, writerEnabled: true };
        }
        if (floor === null) {
          const predecessor = config.currentVersion - 1;
          const minimumWriterVersion = configuredVersions.has(predecessor)
            ? predecessor
            : config.currentVersion;
          if (minimumWriterVersion === config.currentVersion && config.currentVersion > 1) {
            await assertClosedAndDrained(transaction);
          }
          await transaction.$executeRaw`
          INSERT INTO public.agent_mission_fingerprint_key_version_floors (
            "keySpace",
            "minimumWriterVersion",
            "highestWriterVersion",
            "writerEnabled"
          ) VALUES (
            ${KEY_SPACE},
            ${minimumWriterVersion},
            ${config.currentVersion},
            TRUE
          )
        `;
          expectedFloor = {
            minimumWriterVersion,
            highestWriterVersion: config.currentVersion,
            writerEnabled: true,
          };
        } else if (
          config.currentVersion >= floor.minimumWriterVersion &&
          config.currentVersion <= floor.highestWriterVersion
        ) {
          expectedFloor = floor;
        } else if (
          floor.minimumWriterVersion === floor.highestWriterVersion &&
          config.currentVersion === floor.highestWriterVersion + 1
        ) {
          await transaction.$executeRaw`
          UPDATE public.agent_mission_fingerprint_key_version_floors
             SET "highestWriterVersion" = ${config.currentVersion}
           WHERE "keySpace" = ${KEY_SPACE}
             AND "minimumWriterVersion" = ${floor.minimumWriterVersion}
             AND "highestWriterVersion" = ${floor.highestWriterVersion}
        `;
          expectedFloor = {
            minimumWriterVersion: floor.minimumWriterVersion,
            highestWriterVersion: config.currentVersion,
            writerEnabled: true,
          };
        } else {
          fail('stage refuses a rollback, gap or third concurrent writer version');
        }
      } else {
        if (
          floor !== null &&
          floor.minimumWriterVersion === config.currentVersion &&
          floor.highestWriterVersion === config.currentVersion &&
          floor.writerEnabled
        ) {
          expectedFloor = floor;
        } else {
          if (
            floor === null ||
            !floor.writerEnabled ||
            floor.highestWriterVersion !== floor.minimumWriterVersion + 1 ||
            config.currentVersion !== floor.highestWriterVersion
          )
            fail('retire requires the adjacent N/N+1 writer floor', 'retire-floor-not-adjacent');
          if (
            !configuredVersions.has(floor.minimumWriterVersion) ||
            !configuredVersions.has(floor.highestWriterVersion)
          )
            fail(
              'retire requires the keyring to cover both admitted writer versions',
              'retire-keyring-incomplete',
            );
          await assertClosedAndDrained(transaction);
          await transaction.$executeRaw`
          UPDATE public.agent_mission_fingerprint_key_version_floors
             SET "minimumWriterVersion" = ${config.currentVersion}
           WHERE "keySpace" = ${KEY_SPACE}
             AND "minimumWriterVersion" = ${floor.minimumWriterVersion}
             AND "highestWriterVersion" = ${floor.highestWriterVersion}
        `;
          expectedFloor = {
            minimumWriterVersion: config.currentVersion,
            highestWriterVersion: config.currentVersion,
            writerEnabled: true,
          };
        }
      }
      if (
        !configuredVersions.has(expectedFloor.minimumWriterVersion) ||
        !configuredVersions.has(expectedFloor.highestWriterVersion)
      )
        fail('keyring does not cover the admitted writer floor', 'writer-floor-key-missing');
      const floors = await transaction.$queryRaw`
      SELECT "minimumWriterVersion", "highestWriterVersion", "writerEnabled"
        FROM public.agent_mission_fingerprint_key_version_floors
       WHERE "keySpace" = ${KEY_SPACE}
    `;
      if (
        floors.length !== 1 ||
        floors[0]?.minimumWriterVersion !== expectedFloor.minimumWriterVersion ||
        floors[0]?.highestWriterVersion !== expectedFloor.highestWriterVersion ||
        floors[0]?.writerEnabled !== true
      )
        fail('writer floor transition did not commit the expected state', 'writer-floor-mismatch');
      return Object.freeze({
        status: config.mode === 'stage' ? 'staged' : 'retired',
        currentVersion: config.currentVersion,
        bindingCount: config.bindings.length,
        writerFloor: Object.freeze({
          minimumWriterVersion: expectedFloor.minimumWriterVersion,
          highestWriterVersion: expectedFloor.highestWriterVersion,
        }),
      });
    },
    {
      // READ COMMITTED est intentionnel : le premier SELECT peut attendre le verrou exclusif.
      // Un snapshot SERIALIZABLE pris avant cette attente masquerait l'event d'un writer partagé
      // qui commit pendant l'attente. Le verrou advisory sérialise déjà tous les managers.
      isolationLevel: 'ReadCommitted',
      maxWait: 10_000,
      timeout: 50_000,
    },
  );
}

async function main() {
  let prisma;
  try {
    const config = parseAgentMissionFingerprintKeyOperation(process.argv[2]);
    // This module also exposes the dependency-free keyring parser used by the
    // staging Railway safety control plane before `pnpm install`. Resolve
    // Prisma only for the database-mutating CLI entry point so importing the
    // safety operator can never depend on application packages being present.
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
    await prisma.$connect();
    const result = await manageAgentMissionFingerprintKeyVersions(config, prisma);
    console.log(`agent-mission-fingerprint-key:${result.status}`);
  } catch (error) {
    const safeCode =
      error instanceof AgentMissionFingerprintKeyOperationError ? error.code : 'unexpected';
    console.error(`agent-mission-fingerprint-key:error:${safeCode}`);
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
