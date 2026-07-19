import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type { MistralConversationBootstrapGrant } from './mistral-conversation-gateway-v2';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import {
  fingerprintMistralConversationPersistenceKey,
  MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE,
  PrismaMistralConversationKeyVersionAuthority,
} from './mistral-conversation-key-version.prisma';
import { TerminalReplayOnlyMistralConversationCompletion } from './mistral-conversation-terminal-replay';

const RUN_MUTATION_CERT =
  process.env.RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT === 'true';
const CERT_BASE_VERSION = Number(
  process.env.BOB_LIVE_MISTRAL_KEY_ROTATION_CERT_BASE_VERSION ?? '1',
);
const ADVISORY_GATE = 1_904_726_113;
const BACKFILL_END_MARKER = ' WHERE version IS NOT NULL;';

async function readMigrationBackfillStatement(): Promise<string> {
  const migration = await readFile(
    resolve(
      process.cwd(),
      'prisma/migrations/20260719020000_mistral_conversation_key_version_floor/migration.sql',
    ),
    'utf8',
  );
  const start = migration.indexOf('WITH observed_versions AS (');
  const end = migration.indexOf(BACKFILL_END_MARKER, start);
  if (start < 0 || end < start) {
    throw new Error('Le backfill versionné est introuvable dans la migration certifiée.');
  }
  return migration.slice(start, end + BACKFILL_END_MARKER.length);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function expectPostgresError(
  operation: Promise<unknown>,
  sqlState: string,
  marker: string,
): Promise<void> {
  try {
    await operation;
    throw new Error('expected_postgres_error');
  } catch (error) {
    const evidence = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
    expect(evidence.code).toBe('P2010');
    expect(evidence.meta?.code).toBe(sqlState);
    expect(String(evidence.meta?.message)).toContain(marker);
  }
}

describe.skipIf(!RUN_MUTATION_CERT)(
  'Bob Live Mistral — certification destructive de rotation sur PostgreSQL éphémère dédié',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mistral-key-rotation-${suffix}`;
    let admins: [PrismaClient, PrismaClient, PrismaClient];
    let worker: PrismaService;
    let identityKeyVersion: number;
    let subjectKeyVersion: number;

    function keySecret(version: number): Uint8Array {
      return new Uint8Array(32).fill(version % 256);
    }

    function keys(currentVersion: number): MistralConversationPersistenceKeyRing {
      return {
        currentVersion,
        secret: (version) => version === currentVersion
          ? keySecret(currentVersion)
          : null,
      };
    }

    function keyVersionAuthority(version: number) {
      return new PrismaMistralConversationKeyVersionAuthority(
        worker,
        version,
        keySecret(version),
      );
    }

    async function bind(admin: PrismaClient, version: number): Promise<void> {
      const fingerprint = fingerprintMistralConversationPersistenceKey(keySecret(version));
      await admin.$executeRaw`
        INSERT INTO realtime_mistral_conversation_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (
          ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}, ${version}, ${fingerprint}
        )
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const [stored] = await admin.$queryRaw<Array<{ keyFingerprint: string }>>`
        SELECT "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings
         WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
           AND "keyVersion" = ${version}
      `;
      expect(stored?.keyFingerprint).toBe(fingerprint);
    }

    function authority(version: number) {
      return new PrismaMistralConversationDurableAuthority(
        worker,
        new TerminalReplayOnlyMistralConversationCompletion(),
        keys(version),
      );
    }

    function digest(label: string): string {
      return createHash('sha256')
        .update(`mistral-key-rotation:${suffix}:${label}`, 'utf8')
        .digest('hex');
    }

    function grant(label: string): MistralConversationBootstrapGrant {
      const admissionSessionId = randomUUID().toLowerCase();
      return {
        bootstrapId: randomUUID(),
        admissionSessionId,
        companyId,
        subjectHash: digest(`subject:${label}`),
        subjectKeyVersion,
        plan: 'pro',
        sessionHandle: admissionSessionId,
        hardExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        contextRevision: 1,
        contextDigest: digest(`context:${label}`),
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 320_000,
      };
    }

    async function seedGrantEvidence(
      missionGrant: MistralConversationBootstrapGrant,
    ): Promise<void> {
      const now = Date.now();
      const hardExpiresAt = new Date(missionGrant.hardExpiresAt);
      if (
        !Number.isFinite(hardExpiresAt.getTime())
        || hardExpiresAt.getTime() <= now
        || missionGrant.sessionHandle !== missionGrant.admissionSessionId.toLowerCase()
      ) {
        throw new Error('Invalid exact Mistral key-rotation certification grant.');
      }
      const issuedAt = new Date(now - 1_000);
      const ticketExpiresAt = new Date(Math.min(now + 60_000, hardExpiresAt.getTime()));
      const retentionExpiresAt = new Date(hardExpiresAt.getTime() + 24 * 60 * 60_000);
      const leaseTokenHash = digest(`lease:${missionGrant.bootstrapId}`);
      const ticketHash = digest(`ticket:${missionGrant.bootstrapId}`);
      const providerCallId = `mcv2:${missionGrant.bootstrapId}`;

      await worker.withTenant(missionGrant.companyId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "providerId", "providerCallId", "reservedAt", "leaseExpiresAt", "hardExpiresAt",
            "activatedAt", "contextSchemaVersion", "contextRevision", "contextPayload",
            "contextDigest", "contextUpdatedAt", "updatedAt", version
          ) VALUES (
            ${missionGrant.companyId}, ${missionGrant.subjectHash},
            ${missionGrant.admissionSessionId}::uuid, ${leaseTokenHash}, 'active', 'mistral',
            ${providerCallId}, ${issuedAt}, ${hardExpiresAt}, ${hardExpiresAt}, ${issuedAt}, 1,
            ${missionGrant.contextRevision},
            ${JSON.stringify({ screen: { name: '/certification/key-rotation' } })}::jsonb,
            ${missionGrant.contextDigest}, ${issuedAt}, ${issuedAt}, 3
          )
        `;
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_bootstrap_tickets (
            id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
            "subjectKeyVersion", "admissionLeaseTokenHash", "ticketHash", protocol, state, plan,
            "contextSchemaVersion", "contextRevision", "contextSnapshot", "contextDigest",
            "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
            "identityEncryptionKeyVersion", "routeMode", "fullDuplexCertified",
            "maxMissionAudioBytes", "issuedAt", "ticketExpiresAt", "leaseExpiresAt",
            "hardExpiresAt", "consumedAt", "retentionExpiresAt", version, "updatedAt"
          ) VALUES (
            ${missionGrant.bootstrapId}::uuid, ${missionGrant.companyId},
            ${missionGrant.admissionSessionId}::uuid, ${missionGrant.sessionHandle},
            ${missionGrant.subjectHash}, ${missionGrant.subjectKeyVersion}, ${leaseTokenHash},
            ${ticketHash}, 'bob.mistral-pcm.v2', 'issued', ${missionGrant.plan}, 1,
            ${missionGrant.contextRevision},
            ${JSON.stringify({ version: 1, revision: missionGrant.contextRevision, context: {} })}::jsonb,
            ${missionGrant.contextDigest}, decode('aa', 'hex'), decode(repeat('11', 12), 'hex'),
            decode(repeat('22', 16), 'hex'), ${identityKeyVersion}, ${missionGrant.routeMode},
            ${missionGrant.fullDuplexCertified}, ${missionGrant.maxMissionAudioBytes}, ${issuedAt},
            ${ticketExpiresAt}, ${hardExpiresAt}, ${hardExpiresAt}, NULL, ${retentionExpiresAt},
            1, ${issuedAt}
          )
        `;

        const [evidence] = await tx.$queryRaw<Array<{
          admissionSessionId: string;
          admissionLeaseTokenHash: string;
          companyId: string;
          contextDigest: string;
          fullDuplexCertified: boolean;
          hardExpiresAt: Date;
          identityEncryptionKeyVersion: number;
          maxMissionAudioBytes: number;
          plan: string;
          providerCallId: string | null;
          providerId: string | null;
          routeMode: string;
          sessionHandle: string;
          state: string;
          subjectHash: string;
          subjectKeyVersion: number;
        }>>`
          SELECT bootstrap."admissionSessionId"::text AS "admissionSessionId",
                 btrim(bootstrap."admissionLeaseTokenHash") AS "admissionLeaseTokenHash",
                 bootstrap."companyId", btrim(bootstrap."contextDigest") AS "contextDigest",
                 bootstrap."fullDuplexCertified", bootstrap."hardExpiresAt",
                 bootstrap."identityEncryptionKeyVersion", bootstrap."maxMissionAudioBytes",
                 bootstrap.plan, lease."providerCallId", lease."providerId",
                 bootstrap."routeMode", bootstrap."sessionHandle", bootstrap.state,
                 btrim(bootstrap."subjectHash") AS "subjectHash", bootstrap."subjectKeyVersion"
            FROM realtime_mistral_conversation_bootstrap_tickets AS bootstrap
            JOIN realtime_session_leases AS lease
              ON lease."companyId" = bootstrap."companyId"
             AND lease."subjectHash" = bootstrap."subjectHash"
             AND lease."sessionId" = bootstrap."admissionSessionId"
           WHERE bootstrap.id = ${missionGrant.bootstrapId}::uuid
        `;
        expect(evidence).toEqual({
          admissionSessionId: missionGrant.admissionSessionId,
          admissionLeaseTokenHash: leaseTokenHash,
          companyId: missionGrant.companyId,
          contextDigest: missionGrant.contextDigest,
          fullDuplexCertified: missionGrant.fullDuplexCertified,
          hardExpiresAt,
          identityEncryptionKeyVersion: identityKeyVersion,
          maxMissionAudioBytes: missionGrant.maxMissionAudioBytes,
          plan: missionGrant.plan,
          providerCallId,
          providerId: 'mistral',
          routeMode: missionGrant.routeMode,
          sessionHandle: missionGrant.sessionHandle,
          state: 'issued',
          subjectHash: missionGrant.subjectHash,
          subjectKeyVersion: missionGrant.subjectKeyVersion,
        });
      });
    }

    async function consumeGrantEvidence(
      missionGrant: MistralConversationBootstrapGrant,
    ): Promise<void> {
      const updated = await worker.withTenant(missionGrant.companyId, (tx) => tx.$executeRaw`
        UPDATE realtime_mistral_conversation_bootstrap_tickets
           SET state = 'consumed', "consumedAt" = clock_timestamp(), version = 2,
               "updatedAt" = clock_timestamp()
         WHERE id = ${missionGrant.bootstrapId}::uuid
           AND "companyId" = ${missionGrant.companyId}
           AND state = 'issued'
      `);
      if (updated !== 1) {
        throw new Error('Mistral key-rotation bootstrap was not consumed exactly.');
      }
    }

    async function open(version: number, label: string) {
      const missionGrant = grant(label);
      await seedGrantEvidence(missionGrant);
      const result = await authority(version).open({
        grant: missionGrant,
        ownerLeaseToken: `owner_${label}_${randomUUID().replaceAll('-', '')}`,
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      });
      if (result.status === 'opened') await consumeGrantEvidence(missionGrant);
      return result;
    }

    async function waitForBlockedRetirement(): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const [row] = await admins[2].$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_stat_activity
             WHERE state = 'active'
               AND wait_event_type = 'Lock'
               AND query LIKE '%UPDATE realtime_mistral_conversation_key_version_floors%'
          ) AS blocked
        `;
        if (row?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Le retirement n’a pas attendu le writer ancien certifié.');
    }

    async function stage(admin: PrismaClient, version: number) {
      const [range] = await admin.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        INSERT INTO realtime_mistral_conversation_key_version_floors (
          "keySpace", "minimumVersion", "highestVersion"
        )
        VALUES (
          ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE},
          ${version},
          ${version}
        )
        ON CONFLICT ("keySpace") DO UPDATE
        SET "highestVersion" = GREATEST(
          realtime_mistral_conversation_key_version_floors."highestVersion",
          EXCLUDED."highestVersion"
        )
        RETURNING "minimumVersion", "highestVersion"
      `;
      return range;
    }

    async function retire(admin: PrismaClient, version: number) {
      const [range] = await admin.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        UPDATE realtime_mistral_conversation_key_version_floors
           SET "minimumVersion" = GREATEST("minimumVersion", ${version})
         WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
           AND ${version} BETWEEN "minimumVersion" AND "highestVersion"
        RETURNING "minimumVersion", "highestVersion"
      `;
      return range;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) throw new Error('DATABASE_URL et DIRECT_URL sont requis.');
      admins = [
        new PrismaClient({ datasourceUrl: directUrl }),
        new PrismaClient({ datasourceUrl: directUrl }),
        new PrismaClient({ datasourceUrl: directUrl }),
      ];
      worker = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([...admins.map((admin) => admin.$connect()), worker.$connect()]);
      if (!Number.isInteger(CERT_BASE_VERSION) || CERT_BASE_VERSION < 1) {
        throw new Error('BOB_LIVE_MISTRAL_KEY_ROTATION_CERT_BASE_VERSION est invalide.');
      }
      const ranges = await admins[0].$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        SELECT "minimumVersion", "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
      `;
      if (CERT_BASE_VERSION === 1) {
        if (ranges.length !== 0) {
          throw new Error('La certification base 1 exige un registre éphémère vide.');
        }
      } else if (
        ranges.length !== 1
        || ranges[0]?.minimumVersion !== CERT_BASE_VERSION - 1
        || ranges[0]?.highestVersion !== CERT_BASE_VERSION
      ) {
        throw new Error(
          'La certification reprise exige exactement la plage éphémère [base-1, base].',
        );
      }
      const [identityRange] = await admins[0].$queryRaw<Array<{ minimumVersion: number }>>`
        SELECT "minimumVersion"
          FROM realtime_mistral_conversation_identity_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-bootstrap-identity-v1'
      `;
      const [subjectRange] = await admins[0].$queryRaw<Array<{ minimumVersion: number }>>`
        SELECT "minimumVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = 'bob-live-subject-hmac-v1'
      `;
      if (!identityRange || !subjectRange) {
        throw new Error('Les registres identité et sujet doivent précéder la rotation persistance.');
      }
      identityKeyVersion = identityRange.minimumVersion;
      subjectKeyVersion = subjectRange.minimumVersion;
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admins[0].company.create({
        data: {
          id: companyId,
          name: 'Mistral key rotation certification',
          legalForm: 'EI',
          siren,
          siret: `${siren}00001`,
          trade: 'certification',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue de la Rotation',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
    }, 30_000);

    afterAll(async () => {
      if (admins?.[0]) {
        await admins[0].$executeRawUnsafe(`
          DROP TRIGGER IF EXISTS "01_bob_test_pause_mistral_key_writer"
            ON realtime_mistral_conversation_outbox
        `).catch(() => undefined);
        await admins[0].$executeRawUnsafe(`
          DROP FUNCTION IF EXISTS bob_test_pause_mistral_key_writer()
        `).catch(() => undefined);
      }
      await Promise.allSettled([
        worker?.$disconnect(),
        ...((admins ?? []) as PrismaClient[]).map((admin) => admin.$disconnect()),
      ]);
    });

    it('backfill le maximum observé dans les deux ledgers avec le SQL exact de migration', async () => {
      const migrationBackfill = await readMigrationBackfillStatement();
      const outboxVersion = CERT_BASE_VERSION + 10;
      const commandVersion = CERT_BASE_VERSION + 11;
      const rollbackMarker = `rollback-mistral-backfill-${suffix}`;

      await expect(
        admins[0].$transaction(async (tx) => {
          // Certification strictement éphémère : les lignes synthétiques et le registre sont
          // toujours annulés avec la transaction. Le mode replica permet de simuler les ledgers
          // legacy tels qu'ils existaient avant l'installation des nouveaux guards.
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
          await tx.$executeRawUnsafe(
            'DELETE FROM realtime_mistral_conversation_key_version_floors',
          );
          await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_outbox (
              "companyId", "missionId", "sessionHandle", "serverSequence", "eventType",
              "payloadCiphertext", "payloadNonce", "payloadTag", "encryptionKeyVersion",
              "payloadBytes", "createdAt", "retentionExpiresAt"
            ) VALUES (
              ${`legacy-outbox-${suffix}`}, ${randomUUID()}::uuid,
              ${`legacy_outbox_${suffix}`}, 0, 'session.ready',
              decode('00', 'hex'), decode(repeat('00', 12), 'hex'),
              decode(repeat('00', 16), 'hex'), ${outboxVersion}, 1,
              clock_timestamp(), clock_timestamp() + interval '1 day'
            )
          `;
          await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_commands (
              "companyId", "missionId", "sessionHandle", "commandIdHash", "commandType",
              "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch",
              "snapshotVersionBefore", "snapshotVersionAfter", "firstServerSequence",
              "eventCount", "createdAt", "retentionExpiresAt"
            ) VALUES (
              ${`legacy-command-${suffix}`}, ${randomUUID()}::uuid,
              ${`legacy_command_${suffix}`}, ${'c'.repeat(64)}, 'ack_events',
              ${'d'.repeat(64)}, ${commandVersion}, 1, 1, 2, 0, 0,
              clock_timestamp(), clock_timestamp() + interval '1 day'
            )
          `;
          await tx.$executeRawUnsafe(migrationBackfill);
          const [range] = await tx.$queryRaw<Array<{
            minimumVersion: number;
            highestVersion: number;
          }>>`
            SELECT "minimumVersion", "highestVersion"
              FROM realtime_mistral_conversation_key_version_floors
             WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
          `;
          expect(range).toEqual({
            minimumVersion: commandVersion,
            highestVersion: commandVersion,
          });
          throw new Error(rollbackMarker);
        }),
      ).rejects.toThrow(rollbackMarker);
    });

    it('initialise, prépare N+1, maintient N puis retire N sans coupure', async () => {
      await bind(admins[0], CERT_BASE_VERSION);
      if (CERT_BASE_VERSION === 1) {
        await expect(
          stage(admins[0], CERT_BASE_VERSION),
        ).resolves.toMatchObject({
          minimumVersion: CERT_BASE_VERSION,
          highestVersion: CERT_BASE_VERSION,
        });
      } else {
        await expect(
          retire(admins[0], CERT_BASE_VERSION),
        ).resolves.toMatchObject({
          minimumVersion: CERT_BASE_VERSION,
          highestVersion: CERT_BASE_VERSION,
        });
      }
      await expect(
        keyVersionAuthority(CERT_BASE_VERSION).assertCurrentVersion(),
      ).resolves.toBeUndefined();
      await expect(
        open(CERT_BASE_VERSION, `initial-v${CERT_BASE_VERSION}`),
      ).resolves.toMatchObject({ status: 'opened' });

      await bind(admins[0], CERT_BASE_VERSION + 1);
      await expect(
        stage(admins[0], CERT_BASE_VERSION + 1),
      ).resolves.toMatchObject({
        minimumVersion: CERT_BASE_VERSION,
        highestVersion: CERT_BASE_VERSION + 1,
      });
      await expect(
        keyVersionAuthority(CERT_BASE_VERSION).assertCurrentVersion(),
      ).resolves.toBeUndefined();
      await expect(
        keyVersionAuthority(CERT_BASE_VERSION + 1).assertCurrentVersion(),
      ).resolves.toBeUndefined();
      await expect(
        open(CERT_BASE_VERSION + 1, `prepared-v${CERT_BASE_VERSION + 1}`),
      ).resolves.toMatchObject({ status: 'opened' });

      await expect(
        retire(admins[0], CERT_BASE_VERSION + 1),
      ).resolves.toMatchObject({
        minimumVersion: CERT_BASE_VERSION + 1,
        highestVersion: CERT_BASE_VERSION + 1,
      });
      await expect(
        keyVersionAuthority(CERT_BASE_VERSION).assertCurrentVersion(),
      ).rejects.toThrow(
        new RegExp(
          `outside the admitted range ${CERT_BASE_VERSION + 1}-${CERT_BASE_VERSION + 1}`,
        ),
      );
      await expect(
        open(CERT_BASE_VERSION, `retired-v${CERT_BASE_VERSION}`),
      ).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('sérialise les préparations puis fait attendre retirement derrière un writer ancien', async () => {
      const retiringVersion = CERT_BASE_VERSION + 2;
      const oldWriterVersion = CERT_BASE_VERSION + 1;
      await bind(admins[0], retiringVersion);
      const results = await Promise.all([
        stage(admins[0], retiringVersion),
        stage(admins[1], retiringVersion),
      ]);
      expect(results).toEqual([
        { minimumVersion: oldWriterVersion, highestVersion: retiringVersion },
        { minimumVersion: oldWriterVersion, highestVersion: retiringVersion },
      ]);

      await admins[0].$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS "01_bob_test_pause_mistral_key_writer"
          ON realtime_mistral_conversation_outbox
      `);
      await admins[0].$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION bob_test_pause_mistral_key_writer()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $function$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_GATE});
          RETURN NEW;
        END;
        $function$
      `);
      await admins[0].$executeRawUnsafe(`
        CREATE TRIGGER "01_bob_test_pause_mistral_key_writer"
        BEFORE INSERT ON realtime_mistral_conversation_outbox
        FOR EACH ROW EXECUTE FUNCTION bob_test_pause_mistral_key_writer()
      `);

      const gateAcquired = deferred<void>();
      const releaseGate = deferred<void>();
      const gate = admins[1].$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_GATE})`;
        gateAcquired.resolve();
        await releaseGate.promise;
      });
      await gateAcquired.promise;

      const oldWriter = open(oldWriterVersion, `overlap-v${oldWriterVersion}`);
      const writerDeadline = Date.now() + 3_000;
      let writerWaiting = false;
      while (Date.now() < writerDeadline) {
        const [row] = await admins[2].$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = 0
               AND objid = ${ADVISORY_GATE}
               AND NOT granted
          ) AS waiting
        `;
        if (row?.waiting) {
          writerWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(writerWaiting).toBe(true);

      const retirement = retire(admins[0], retiringVersion);
      await waitForBlockedRetirement();
      releaseGate.resolve();
      await gate;
      await expect(oldWriter).resolves.toMatchObject({ status: 'opened' });
      await expect(retirement).resolves.toEqual({
        minimumVersion: retiringVersion,
        highestVersion: retiringVersion,
      });

      await expect(
        open(oldWriterVersion, `after-retire-v${oldWriterVersion}`),
      ).resolves.toMatchObject({ status: 'unavailable' });
      await expect(
        open(retiringVersion, `after-retire-v${retiringVersion}`),
      ).resolves.toMatchObject({ status: 'opened' });
    });

    it('refuse sauts de version, retour arrière, suppression et truncate', async () => {
      await expectPostgresError(
        stage(admins[0], CERT_BASE_VERSION + 4),
        '23514',
        'MISTRAL_CONVERSATION_KEY_VERSION_TRANSITION_INVALID',
      );
      await expectPostgresError(
        admins[0].$executeRaw`
          UPDATE realtime_mistral_conversation_key_version_floors
             SET "minimumVersion" = 1
        `,
        '23514',
        'MISTRAL_CONVERSATION_KEY_VERSION_ROLLBACK',
      );
      await expectPostgresError(
        admins[0].$executeRaw`DELETE FROM realtime_mistral_conversation_key_version_floors`,
        '23514',
        'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY',
      );
      await expectPostgresError(
        admins[0].$executeRaw`TRUNCATE realtime_mistral_conversation_key_version_floors`,
        '23514',
        'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY',
      );
      await expectPostgresError(
        admins[0].$executeRaw`
          UPDATE realtime_mistral_conversation_key_bindings
             SET "keyFingerprint" = ${'f'.repeat(64)}
        `,
        '23514',
        'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY',
      );
      await expectPostgresError(
        admins[0].$executeRaw`DELETE FROM realtime_mistral_conversation_key_bindings`,
        '23514',
        'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY',
      );
      await expectPostgresError(
        admins[0].$executeRaw`TRUNCATE realtime_mistral_conversation_key_bindings`,
        '23514',
        'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY',
      );
    });
  },
);
