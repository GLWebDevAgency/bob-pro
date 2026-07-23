import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { createOpenAiNativeSpeechDelivery } from './openai-native-speech-delivery';

const RUN_CERT = process.env.RUN_POSTGRES_OPENAI_NATIVE_KEY_LIFECYCLE_CERT === 'true';
const DATABASE_KIND = process.env.OPENAI_NATIVE_KEY_LIFECYCLE_CERT_DATABASE_KIND;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const EPHEMERAL_DATABASE = /^bob_ephemeral_[a-z0-9_]{1,48}$/u;
const SUBJECT_KEY_SPACE = 'bob-live-subject-hmac-v1';
const PROOF_KEY_SPACE = 'openai-native-speech-proof-hmac-v1';
const PROOF_V2_SECRET = 'openai-native-proof-v2-postgres-cert-2026';
const DAY_MS = 24 * 60 * 60 * 1_000;

function certifyEphemeralTarget(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a canonical PostgreSQL URL.`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !EPHEMERAL_DATABASE.test(database)) {
    throw new Error(`${label} must target loopback and a bob_ephemeral_* database.`);
  }
  return database;
}

if (RUN_CERT) {
  if (DATABASE_KIND !== 'ephemeral') {
    throw new Error('OPENAI_NATIVE_KEY_LIFECYCLE_CERT_DATABASE_KIND=ephemeral is required.');
  }
  const runtimeDatabase = certifyEphemeralTarget(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
  const directDatabase = certifyEphemeralTarget(process.env.DIRECT_URL ?? '', 'DIRECT_URL');
  if (runtimeDatabase !== directDatabase) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same ephemeral database.');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function parseKeyring(name: string): Readonly<Record<string, string>> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for the PostgreSQL certificate.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be an object.`);
  }
  return parsed as Readonly<Record<string, string>>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectDatabaseRejection(
  operation: Promise<unknown>,
  marker: RegExp,
): Promise<void> {
  try {
    await operation;
    throw new Error('expected_database_rejection');
  } catch (error) {
    expect(String(error)).toMatch(marker);
  }
}

describe.skipIf(!RUN_CERT)(
  'Bob Live OpenAI natif — cycle de clés et course writer/retire sur PostgreSQL éphémère',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `native-key-lifecycle-${suffix}`;
    const subjectKeys = RUN_CERT ? parseKeyring('BOB_LIVE_SUBJECT_HMAC_KEYRING') : {};
    const proofKeys = RUN_CERT ? parseKeyring('BOB_LIVE_PROOF_KEYRING') : {};
    const subjectV1 = subjectKeys['1'] ?? '';
    const subjectV2 = subjectKeys['2'] ?? '';
    const proofV1 = proofKeys['1'] ?? '';
    let adminA: PrismaClient;
    let adminB: PrismaClient;
    let runtime: PrismaService;

    function company() {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id: companyId,
        name: 'OpenAI native key lifecycle PostgreSQL certification',
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}${String(randomInt(0, 99_999)).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    async function bind(
      tx: Prisma.TransactionClient,
      keySpace: string,
      version: number,
      secret: string,
    ): Promise<void> {
      const expected = fingerprint(secret);
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (${keySpace}, ${version}, ${expected})
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const [stored] = await tx.$queryRaw<Array<{ keyFingerprint: string }>>`
        SELECT "keyFingerprint"::text AS "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings
         WHERE "keySpace" = ${keySpace}
           AND "keyVersion" = ${version}
      `;
      if (stored?.keyFingerprint !== expected) {
        throw new Error(`${keySpace} version ${version} material mismatch`);
      }
    }

    async function stageV2(): Promise<void> {
      await adminA.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SUBJECT_KEY_SPACE}, 0))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROOF_KEY_SPACE}, 0))`;
        await bind(tx, SUBJECT_KEY_SPACE, 1, subjectV1);
        await bind(tx, SUBJECT_KEY_SPACE, 2, subjectV2);
        await bind(tx, PROOF_KEY_SPACE, 1, proofV1);
        await bind(tx, PROOF_KEY_SPACE, 2, PROOF_V2_SECRET);
        for (const keySpace of [SUBJECT_KEY_SPACE, PROOF_KEY_SPACE]) {
          const updated = await tx.$executeRaw`
            UPDATE realtime_mistral_conversation_key_version_floors
               SET "highestVersion" = 2
             WHERE "keySpace" = ${keySpace}
               AND "minimumVersion" = 1
               AND "highestVersion" = 1
          `;
          if (updated !== 1) {
            const [range] = await tx.$queryRaw<Array<{
              minimumVersion: number;
              highestVersion: number;
            }>>`
              SELECT "minimumVersion", "highestVersion"
                FROM realtime_mistral_conversation_key_version_floors
               WHERE "keySpace" = ${keySpace}
            `;
            expect(range).toEqual({ minimumVersion: 1, highestVersion: 2 });
          }
        }
      });
    }

    async function retireV1(client: PrismaClient): Promise<void> {
      await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SUBJECT_KEY_SPACE}, 0))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROOF_KEY_SPACE}, 0))`;
        for (const keySpace of [SUBJECT_KEY_SPACE, PROOF_KEY_SPACE]) {
          const updated = await tx.$executeRaw`
            UPDATE realtime_mistral_conversation_key_version_floors
               SET "minimumVersion" = 2
             WHERE "keySpace" = ${keySpace}
               AND "minimumVersion" = 1
               AND "highestVersion" = 2
          `;
          if (updated !== 1) throw new Error(`${keySpace} retirement did not mutate exactly once`);
        }
      });
    }

    async function ranges(): Promise<Array<{
      keySpace: string;
      minimumVersion: number;
      highestVersion: number;
    }>> {
      return adminA.$queryRaw`
        SELECT "keySpace", "minimumVersion", "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" IN (${SUBJECT_KEY_SPACE}, ${PROOF_KEY_SPACE})
         ORDER BY "keySpace"
      `;
    }

    interface Authority {
      sessionId: string;
      subjectHmac: string;
      contextDigest: string;
      ownerTokenHmac: string;
    }

    async function seedAuthority(label: string): Promise<Authority> {
      const sessionId = randomUUID();
      const subjectHmac = digest(`${suffix}:subject:${label}`);
      const contextDigest = digest(`${suffix}:context:${label}`);
      const ownerTokenHmac = digest(`${suffix}:owner-token:${label}`);
      const ownerInstanceHmac = digest(`${suffix}:owner-instance:${label}`);
      const leaseTokenHash = digest(`${suffix}:lease:${label}`);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60_000);
      await adminA.$executeRaw`
        INSERT INTO realtime_session_leases (
          "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
          "providerId", "providerCallId", "reservedAt", "leaseExpiresAt", "hardExpiresAt",
          "activatedAt", "contextSchemaVersion", "contextRevision", "contextPayload",
          "contextDigest", "contextUpdatedAt", "sidebandOwnerInstanceHash",
          "sidebandOwnerTokenHash", "sidebandOwnerLeaseExpiresAt", "sidebandOwnerEpoch",
          "contextAppliedRevision", "contextAppliedDigest", "contextAppliedAt",
          "contextAppliedOwnerEpoch", "sidebandProtocolVersion", "updatedAt", version
        ) VALUES (
          ${companyId}, ${subjectHmac}, ${sessionId}::uuid, ${leaseTokenHash}, 'active',
          'openai', ${`native-key-cert:${label}:${suffix}`}, ${now}, ${expiresAt}, ${expiresAt},
          ${now}, 1, 1, ${JSON.stringify({ screen: { name: '/certification/native-key' } })}::jsonb,
          ${contextDigest}, ${now}, ${ownerInstanceHmac}, ${ownerTokenHmac}, ${expiresAt}, 1,
          1, ${contextDigest}, ${now}, 1, 2, ${now}, 3
        )
      `;
      return { sessionId, subjectHmac, contextDigest, ownerTokenHmac };
    }

    function prepared(
      authority: Authority,
      label: string,
      subjectKeyVersion: number,
      proofKeyVersion: number,
    ) {
      const now = Date.now();
      return createOpenAiNativeSpeechDelivery({
        deliveryId: randomUUID(),
        companyId,
        subjectHmac: authority.subjectHmac,
        subjectKeyVersion,
        sessionId: authority.sessionId,
        turnId: randomUUID(),
        contextRevision: 1,
        contextDigest: authority.contextDigest,
        sidebandOwnerEpoch: 1,
        sidebandOwnerTokenHmac: authority.ownerTokenHmac,
        speechPolicyVersion: 1,
        speechScenarioId: 'generic_help_v1',
        canonicalSpeechHmac: digest(`${suffix}:speech:${label}`),
        factsHmac: digest(`${suffix}:facts:${label}`),
        requestNonceHmac: digest(`${suffix}:nonce:${label}`),
        proofFormatVersion: 2,
        proofKeyVersion,
        provider: 'openai',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      });
    }

    async function insertPrepared(
      tx: Prisma.TransactionClient,
      state: ReturnType<typeof prepared>,
      releaseOwner: boolean,
    ): Promise<void> {
      await tx.realtimeNativeSpeechDelivery.create({
        data: {
          deliveryId: state.deliveryId,
          companyId: state.companyId,
          subjectHmac: state.subjectHmac,
          subjectKeyVersion: state.subjectKeyVersion,
          sessionId: state.sessionId,
          turnId: state.turnId,
          contextRevision: state.contextRevision,
          contextDigest: state.contextDigest,
          sidebandOwnerEpoch: state.sidebandOwnerEpoch,
          sidebandOwnerTokenHmac: state.sidebandOwnerTokenHmac,
          speechPolicyVersion: state.speechPolicyVersion,
          speechScenarioId: state.speechScenarioId,
          canonicalSpeechHmac: state.canonicalSpeechHmac,
          factsHmac: state.factsHmac,
          requestNonceHmac: state.requestNonceHmac,
          proofFormatVersion: state.proofFormatVersion,
          proofKeyVersion: state.proofKeyVersion,
          provider: state.provider,
          model: state.model,
          voice: state.voice,
          version: state.version,
          revision: state.revision,
          phase: state.phase,
          createdAt: new Date(state.createdAtMs),
          expiresAt: new Date(state.expiresAtMs),
          retentionExpiresAt: new Date(state.createdAtMs + 30 * DAY_MS),
        },
      });
      if (releaseOwner) {
        const released = await tx.realtimeSessionLease.updateMany({
          where: { companyId, sessionId: state.sessionId },
          data: {
            sidebandOwnerInstanceHash: null,
            sidebandOwnerTokenHash: null,
            sidebandOwnerLeaseExpiresAt: null,
            contextAppliedRevision: null,
            contextAppliedDigest: null,
            contextAppliedAt: null,
            contextAppliedOwnerEpoch: null,
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        expect(released.count).toBe(1);
      }
    }

    async function waitForAdvisoryWaiter(): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const [row] = await adminA.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          ) AS waiting
        `;
        if (row?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('The retirement transaction never waited for the N-1 writer.');
    }

    beforeAll(async () => {
      if (!subjectV1 || !subjectV2 || !proofV1) {
        throw new Error('The native lifecycle certificate requires subject v1/v2 and proof v1.');
      }
      adminA = new PrismaClient({ datasourceUrl: directUrl });
      adminB = new PrismaClient({ datasourceUrl: directUrl });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([adminA.$connect(), adminB.$connect(), runtime.$connect()]);
      await adminA.company.create({ data: company() });
    }, 30_000);

    afterAll(async () => {
      if (adminA) {
        await adminA.realtimeNativeSpeechDelivery.deleteMany({ where: { companyId } }).catch(() => undefined);
        await adminA.realtimeSessionLease.deleteMany({ where: { companyId } }).catch(() => undefined);
        await adminA.realtimeAdmissionEvent.deleteMany({ where: { companyId } }).catch(() => undefined);
        await adminA.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
      }
      await Promise.allSettled([
        ...(adminA ? [adminA.$disconnect()] : []),
        ...(adminB ? [adminB.$disconnect()] : []),
        ...(runtime ? [runtime.$disconnect()] : []),
      ]);
    });

    it('refuse A/v1→B/v1, retient sujet/preuve/legacy et sérialise les deux ordres writer↔retire', async () => {
      const wrongFingerprint = fingerprint('different-proof-v1-material-for-cert-2026');
      await expectDatabaseRejection(adminA.$executeRaw`
        UPDATE realtime_mistral_conversation_key_bindings
           SET "keyFingerprint" = ${wrongFingerprint}
         WHERE "keySpace" = ${PROOF_KEY_SPACE}
           AND "keyVersion" = 1
      `, /KEY_BINDING_APPEND_ONLY/u);

      const [runtimeRole] = await runtime.$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        canUpdateFloor: boolean;
      }>>`
        SELECT role.rolsuper, role.rolbypassrls,
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_key_version_floors',
                 'UPDATE'
               ) AS "canUpdateFloor"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(runtimeRole).toEqual({ rolsuper: false, rolbypassrls: false, canUpdateFloor: false });

      await stageV2();
      expect(await ranges()).toEqual([
        { keySpace: SUBJECT_KEY_SPACE, minimumVersion: 1, highestVersion: 2 },
        { keySpace: PROOF_KEY_SPACE, minimumVersion: 1, highestVersion: 2 },
      ].sort((left, right) => left.keySpace.localeCompare(right.keySpace)));

      const writerAuthority = await seedAuthority('writer-first');
      const writerState = prepared(writerAuthority, 'writer-first', 1, 1);
      const inserted = deferred();
      const commitWriter = deferred();
      const writer = runtime.withIsolatedTenant(companyId, async (tx) => {
        await insertPrepared(tx, writerState, true);
        inserted.resolve();
        await commitWriter.promise;
      }, { maxWaitMs: 1_000, timeoutMs: 5_000 });
      await inserted.promise;
      const retirementBehindWriter = retireV1(adminB);
      await waitForAdvisoryWaiter();
      commitWriter.resolve();
      await writer;
      await expectDatabaseRejection(
        retirementBehindWriter,
        /BOB_LIVE_SUBJECT_KEY_VERSION_RETAINED/u,
      );
      expect(await ranges()).toEqual([
        { keySpace: SUBJECT_KEY_SPACE, minimumVersion: 1, highestVersion: 2 },
        { keySpace: PROOF_KEY_SPACE, minimumVersion: 1, highestVersion: 2 },
      ].sort((left, right) => left.keySpace.localeCompare(right.keySpace)));
      await adminA.realtimeNativeSpeechDelivery.delete({
        where: { deliveryId: writerState.deliveryId },
      });
      await adminA.realtimeSessionLease.deleteMany({ where: { companyId } });

      const proofAuthority = await seedAuthority('proof-retained');
      const proofState = prepared(proofAuthority, 'proof-retained', 2, 1);
      await runtime.withIsolatedTenant(companyId, (tx) => insertPrepared(tx, proofState, true));
      await expectDatabaseRejection(retireV1(adminB), /OPENAI_NATIVE_PROOF_KEY_VERSION_RETAINED/u);
      await adminA.realtimeNativeSpeechDelivery.delete({ where: { deliveryId: proofState.deliveryId } });
      await adminA.realtimeSessionLease.deleteMany({ where: { companyId } });

      const legacyAuthority = await seedAuthority('legacy-null');
      const legacyState = prepared(legacyAuthority, 'legacy-null', 2, 2);
      await adminA.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.realtimeNativeSpeechDelivery.create({
          data: {
            deliveryId: legacyState.deliveryId,
            companyId,
            subjectHmac: legacyState.subjectHmac,
            subjectKeyVersion: null,
            sessionId: legacyState.sessionId,
            turnId: legacyState.turnId,
            contextRevision: 1,
            contextDigest: legacyState.contextDigest,
            sidebandOwnerEpoch: 1,
            sidebandOwnerTokenHmac: legacyState.sidebandOwnerTokenHmac,
            speechPolicyVersion: 1,
            speechScenarioId: 'generic_help_v1',
            canonicalSpeechHmac: legacyState.canonicalSpeechHmac,
            factsHmac: legacyState.factsHmac,
            requestNonceHmac: legacyState.requestNonceHmac,
            proofFormatVersion: 2,
            proofKeyVersion: 2,
            provider: 'openai',
            model: 'gpt-realtime-2.1',
            voice: 'marin',
            phase: 'prepared',
            createdAt: new Date(legacyState.createdAtMs),
            expiresAt: new Date(legacyState.expiresAtMs),
            retentionExpiresAt: new Date(legacyState.createdAtMs + 30 * DAY_MS),
          },
        });
      });
      await expectDatabaseRejection(retireV1(adminB), /BOB_LIVE_SUBJECT_KEY_VERSION_RETAINED/u);
      await adminA.realtimeNativeSpeechDelivery.delete({ where: { deliveryId: legacyState.deliveryId } });
      await adminA.realtimeSessionLease.deleteMany({ where: { companyId } });

      await retireV1(adminB);
      expect(await ranges()).toEqual([
        { keySpace: SUBJECT_KEY_SPACE, minimumVersion: 2, highestVersion: 2 },
        { keySpace: PROOF_KEY_SPACE, minimumVersion: 2, highestVersion: 2 },
      ].sort((left, right) => left.keySpace.localeCompare(right.keySpace)));

      const retiredWriterAuthority = await seedAuthority('retire-first');
      const retiredWriterState = prepared(retiredWriterAuthority, 'retire-first', 1, 1);
      await expectDatabaseRejection(
        runtime.withIsolatedTenant(
          companyId,
          (tx) => insertPrepared(tx, retiredWriterState, false),
        ),
        /key is not admitted and bound/u,
      );
      expect(await adminA.realtimeNativeSpeechDelivery.count({
        where: { deliveryId: retiredWriterState.deliveryId },
      })).toBe(0);
    }, 30_000);
  },
);
