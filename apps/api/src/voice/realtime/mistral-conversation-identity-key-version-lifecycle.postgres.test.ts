import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';

const RUN_IDENTITY_ROTATION_CERT =
  process.env.RUN_POSTGRES_MISTRAL_IDENTITY_KEY_ROTATION_CERT === 'true';
const IDENTITY_KEY_SPACE = 'mistral-conversation-bootstrap-identity-v1';
const PROTOCOL = 'bob.mistral-pcm.v2';
const INT32_MAX = 0x7fff_ffff;
const WRITER_GATE = 1_904_726_115;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fingerprint(version: number): string {
  const rawKeyring = process.env.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING;
  let configuredKeyMaterial: Buffer | null = null;
  if (rawKeyring) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawKeyring);
    } catch {
      throw new Error('Le keyring identité de mutation-cert doit être un objet JSON valide.');
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Le keyring identité de mutation-cert doit être un objet JSON.');
    }
    const rawSecret = (decoded as Record<string, unknown>)[String(version)];
    if (rawSecret !== undefined) {
      if (typeof rawSecret !== 'string') {
        throw new Error(`La clé identité v${version} de mutation-cert est invalide.`);
      }
      const keyMaterial = Buffer.from(rawSecret, 'base64url');
      if (keyMaterial.byteLength !== 32 || keyMaterial.toString('base64url') !== rawSecret) {
        throw new Error(`La clé identité v${version} de mutation-cert n’est pas canonique.`);
      }
      configuredKeyMaterial = keyMaterial;
    }
  }
  const keyMaterial = configuredKeyMaterial ?? createHash('sha256')
    .update(`bob-cert-bootstrap-identity-key-v${version}`, 'utf8')
    .digest();
  return createHash('sha256')
    .update(keyMaterial)
    .digest('hex');
}

function postgresEvidence(error: unknown) {
  return error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
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
    const evidence = postgresEvidence(error);
    expect(evidence.code).toBe('P2010');
    expect(evidence.meta?.code).toBe(sqlState);
    expect(String(evidence.meta?.message)).toContain(marker);
  }
}

describe.skipIf(!RUN_IDENTITY_ROTATION_CERT)(
  'Bob Live Mistral — rotation durable du keyring identité sur PostgreSQL éphémère',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mistral-identity-key-rotation-${suffix}`;
    let admins: [PrismaClient, PrismaClient, PrismaClient];
    let worker: PrismaService;
    let minimumVersion: number;
    let highestVersion: number;

    function digest(domain: string, label: string): string {
      return createHash('sha256')
        .update(`${domain}:${suffix}:${label}`, 'utf8')
        .digest('hex');
    }

    async function bind(tx: Prisma.TransactionClient, version: number): Promise<void> {
      const expectedFingerprint = fingerprint(version);
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_identity_key_bindings (
          "keySpace", "keyVersion", "keyFingerprint"
        ) VALUES (${IDENTITY_KEY_SPACE}, ${version}, ${expectedFingerprint})
        ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
      `;
      const [stored] = await tx.$queryRaw<Array<{ keyFingerprint: string }>>`
        SELECT "keyFingerprint"
          FROM realtime_mistral_conversation_identity_key_bindings
         WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
           AND "keyVersion" = ${version}
      `;
      if (stored?.keyFingerprint !== expectedFingerprint) {
        throw new Error(`Le binding identité v${version} ne correspond pas à la mutation-cert.`);
      }
    }

    async function prepareMixedRange(): Promise<{
      minimumVersion: number;
      highestVersion: number;
    }> {
      return admins[0].$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${IDENTITY_KEY_SPACE}, 0))
        `;
        const [retained] = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count
            FROM realtime_mistral_conversation_bootstrap_tickets
        `;
        if (!retained || retained.count !== 0) {
          throw new Error(
            'La mutation-cert identité exige une base éphémère sans preuve bootstrap préalable.',
          );
        }
        const ranges = await tx.$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          SELECT "minimumVersion", "highestVersion"
            FROM realtime_mistral_conversation_identity_key_version_floors
           WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
        `;
        if (ranges.length > 1) throw new Error('Plusieurs plages identité ont été retournées.');
        let range = ranges[0] ?? null;
        if (range === null) {
          await bind(tx, 1);
          const [initialized] = await tx.$queryRaw<Array<{
            minimumVersion: number;
            highestVersion: number;
          }>>`
            INSERT INTO realtime_mistral_conversation_identity_key_version_floors (
              "keySpace", "minimumVersion", "highestVersion"
            ) VALUES (${IDENTITY_KEY_SPACE}, 1, 1)
            RETURNING "minimumVersion", "highestVersion"
          `;
          range = initialized ?? null;
        }
        if (
          !range
          || !Number.isInteger(range.minimumVersion)
          || !Number.isInteger(range.highestVersion)
          || range.minimumVersion < 1
          || range.minimumVersion !== range.highestVersion
          || range.highestVersion >= INT32_MAX
        ) {
          throw new Error('La mutation-cert identité exige une plage stable incrémentable.');
        }
        const nextVersion = range.highestVersion + 1;
        await bind(tx, range.minimumVersion);
        await bind(tx, nextVersion);
        const [staged] = await tx.$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          UPDATE realtime_mistral_conversation_identity_key_version_floors
             SET "highestVersion" = ${nextVersion}
           WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
             AND "minimumVersion" = ${range.minimumVersion}
             AND "highestVersion" = ${range.highestVersion}
          RETURNING "minimumVersion", "highestVersion"
        `;
        if (
          !staged
          || staged.minimumVersion !== range.minimumVersion
          || staged.highestVersion !== nextVersion
        ) throw new Error('La préparation additive de la plage identité a échoué.');
        return staged;
      });
    }

    async function insertBootstrap(version: number, label: string): Promise<string> {
      const id = randomUUID();
      const admissionSessionId = randomUUID();
      const context = JSON.stringify({
        version: 1,
        revision: 1,
        context: { screen: { name: '/identity-key-cert', instanceId: label } },
      });
      await worker.withTenant(companyId, async (tx) => {
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
            ${id}::uuid, ${companyId}, ${admissionSessionId}::uuid, ${admissionSessionId},
            ${digest('subject', label)}, 1, ${digest('lease', label)}, ${digest('ticket', label)},
            ${PROTOCOL}, 'issued', 'pro', 1, 1, ${context}::jsonb,
            ${digest('context', label)}, ${Buffer.alloc(32, version % 255 || 1)},
            ${Buffer.alloc(12, 2)}, ${Buffer.alloc(16, 3)}, ${version}, 'push_to_talk', false,
            320, clock_timestamp(), clock_timestamp() + interval '60 seconds',
            clock_timestamp() + interval '120 seconds',
            clock_timestamp() + interval '180 seconds', NULL,
            clock_timestamp() + interval '1 hour', 1, clock_timestamp()
          )
        `;
      });
      return id;
    }

    async function waitForWriterGate(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await admins[2].$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = 0
               AND objid = ${WRITER_GATE}
               AND NOT granted
          ) AS waiting
        `;
        if (row?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Le writer bootstrap ancien n’a pas atteint le verrou de pause.');
    }

    async function waitForRetirementLock(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await admins[2].$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_stat_activity AS activity
             WHERE activity.datname = current_database()
               AND activity.query LIKE
                 '%UPDATE realtime_mistral_conversation_identity_key_version_floors%'
               AND cardinality(pg_blocking_pids(activity.pid)) > 0
          ) AS blocked
        `;
        if (row?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Le retirement identité n’a pas attendu le writer bootstrap ancien.');
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
      const range = await prepareMixedRange();
      minimumVersion = range.minimumVersion;
      highestVersion = range.highestVersion;
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admins[0].company.create({
        data: {
          id: companyId,
          name: 'Mistral identity key rotation certification',
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
          DROP TRIGGER IF EXISTS "01_bob_test_pause_mistral_identity_writer"
            ON realtime_mistral_conversation_bootstrap_tickets
        `).catch(() => undefined);
        await admins[0].$executeRawUnsafe(`
          DROP FUNCTION IF EXISTS bob_test_pause_mistral_identity_writer()
        `).catch(() => undefined);
      }
      await Promise.allSettled([
        ...((admins ?? []) as PrismaClient[]).map((admin) => admin.$disconnect()),
        ...(worker ? [worker.$disconnect()] : []),
      ]);
    });

    it('fait committer le writer ancien avant le veto de retirement, sans perdre sa clé', async () => {
      await admins[0].$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION bob_test_pause_mistral_identity_writer()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $function$
        BEGIN
          PERFORM pg_advisory_xact_lock(${WRITER_GATE});
          RETURN NEW;
        END;
        $function$
      `);
      await admins[0].$executeRawUnsafe(`
        CREATE TRIGGER "01_bob_test_pause_mistral_identity_writer"
        BEFORE INSERT ON realtime_mistral_conversation_bootstrap_tickets
        FOR EACH ROW EXECUTE FUNCTION bob_test_pause_mistral_identity_writer()
      `);

      const gateAcquired = deferred<void>();
      const releaseGate = deferred<void>();
      let gate: Promise<unknown> | null = null;
      try {
        gate = admins[1].$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITER_GATE})`;
          gateAcquired.resolve();
          await releaseGate.promise;
        }, { timeout: 15_000 });
        await gateAcquired.promise;

        const oldWriter = insertBootstrap(minimumVersion, 'old-writer-overlap');
        await waitForWriterGate();
        const retirement = admins[0].$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          UPDATE realtime_mistral_conversation_identity_key_version_floors
             SET "minimumVersion" = ${highestVersion}
           WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
             AND "minimumVersion" = ${minimumVersion}
             AND "highestVersion" = ${highestVersion}
          RETURNING "minimumVersion", "highestVersion"
        `.then(
          (value) => ({ value, error: null as unknown }),
          (error: unknown) => ({ value: null, error }),
        );
        await waitForRetirementLock();

        releaseGate.resolve();
        await gate;
        const oldId = await oldWriter;
        const retirementResult = await retirement;
        expect(retirementResult.value).toBeNull();
        const evidence = postgresEvidence(retirementResult.error);
        expect(evidence.code).toBe('P2010');
        expect(evidence.meta?.code).toBe('23514');
        expect(String(evidence.meta?.message)).toContain(
          'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RETAINED',
        );
        const [persisted] = await admins[2].$queryRaw<Array<{
          id: string;
          keyVersion: number;
        }>>`
          SELECT id::text, "identityEncryptionKeyVersion" AS "keyVersion"
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE id = ${oldId}::uuid
        `;
        expect(persisted).toEqual({ id: oldId, keyVersion: minimumVersion });

        await expect(insertBootstrap(highestVersion, 'new-writer-control')).resolves.toMatch(
          /^[a-f0-9-]{36}$/u,
        );
        await expectPostgresError(
          insertBootstrap(highestVersion + 1, 'future-writer-refused'),
          '23514',
          'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_NOT_ADMITTED',
        );
      } finally {
        releaseGate.resolve();
        await gate?.catch(() => undefined);
      }
    }, 30_000);

    it('maintient le rôle runtime non privilégié et read-only sur le registre identité', async () => {
      const [role] = await worker.$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await expectPostgresError(
        worker.$executeRaw`
          UPDATE realtime_mistral_conversation_identity_key_version_floors
             SET "highestVersion" = "highestVersion"
           WHERE "keySpace" = ${IDENTITY_KEY_SPACE}
        `,
        '42501',
        'permission denied',
      );
    });
  },
);
