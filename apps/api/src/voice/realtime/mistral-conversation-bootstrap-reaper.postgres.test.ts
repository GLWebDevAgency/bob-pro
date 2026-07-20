import { createHash, randomInt, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationBootstrapReaper } from './mistral-conversation-bootstrap-reaper.prisma';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_CERT === 'true';
const REAPER_ROLE = 'bob_mistral_bootstrap_reaper';

interface RetentionFixture {
  readonly bootstrapId: string;
  readonly missionId: string;
  readonly companyId: string;
  readonly admissionSessionId: string;
  readonly sessionHandle: string;
  readonly subjectHash: string;
  readonly retentionExpiresAt: Date;
}

interface RetentionFixtureOptions {
  readonly companyId?: string;
  readonly createdAt?: Date;
  readonly phase?: 'ready' | 'closed';
  readonly withChildren?: boolean;
  readonly withLease?: boolean;
}

interface RetentionCounts {
  readonly bootstraps: number;
  readonly missions: number;
  readonly receipts: number;
  readonly resumes: number;
  readonly commands: number;
  readonly outbox: number;
  readonly leases: number;
}

class RollbackCertificationFixture extends Error {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function expectPostgresError(
  error: unknown,
  sqlState: string,
  marker: string,
): void {
  const evidence = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
  expect(evidence.code).toBe('P2010');
  expect(evidence.meta?.code).toBe(sqlState);
  expect(String(evidence.meta?.message)).toContain(marker);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function replayReaperProvisioning(runtimeUrl: string, directUrl: string): void {
  const certification = spawnSync(
    'sh',
    [resolve(process.cwd(), 'scripts/certify-mistral-conversation-authority.sh')],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: runtimeUrl,
        DIRECT_URL: directUrl,
        BOB_LIVE_MISTRAL_V2_PROVISION_ONLY: 'true',
      },
      timeout: 60_000,
    },
  );
  if (certification.status !== 0) {
    throw new Error(
      `Mistral reaper provisioning replay failed:\n${certification.stdout}\n${certification.stderr}`,
    );
  }
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral v2 bootstrap reaper — certification connexion runtime réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mcv2-retention-${suffix}`;
    const otherCompanyId = `mcv2-retention-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const setupUrl = process.env.POSTGRES_MISTRAL_CONVERSATION_CERT_SETUP_URL ?? directUrl;
    let runtime: PrismaService;
    let runtime2: PrismaService;
    let admin: PrismaClient;
    let setup: PrismaClient;
    let reaper: PrismaMistralConversationBootstrapReaper;
    let reaper2: PrismaMistralConversationBootstrapReaper;
    let persistenceKeyVersion: number;
    let identityKeyVersion: number;

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral ordered retention certification ${discriminator}`,
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}${String(discriminator).padStart(5, '0')}`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: `${discriminator} rue de la Certification`,
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    function digest(label: string): string {
      return createHash('sha256')
        .update(`mcv2-retention:${suffix}:${label}`, 'utf8')
        .digest('hex');
    }

    async function insertFixture(
      tx: Prisma.TransactionClient,
      label: string,
      options: RetentionFixtureOptions = {},
    ): Promise<RetentionFixture> {
      const tenantId = options.companyId ?? companyId;
      const phase = options.phase ?? 'closed';
      const withChildren = options.withChildren ?? (phase === 'closed');
      if (options.withLease && (phase !== 'closed' || !withChildren)) {
        throw new Error('A lease fixture requires the exact terminal outbox pair.');
      }

      const bootstrapId = randomUUID();
      const missionId = randomUUID();
      const admissionSessionId = randomUUID();
      const sessionHandle = admissionSessionId;
      const subjectHash = digest(`subject:${label}`);
      const contextDigest = digest(`context:${label}`);
      const createdAt = options.createdAt ?? new Date(Date.now() - 10 * 60_000);
      const ticketExpiresAt = new Date(createdAt.getTime() + 60_000);
      const leaseExpiresAt = new Date(createdAt.getTime() + 70_000);
      const hardExpiresAt = new Date(createdAt.getTime() + 120_000);
      const replayGraceExpiresAt = new Date(createdAt.getTime() + 180_000);
      const retentionExpiresAt = new Date(createdAt.getTime() + 240_000);
      const consumedAt = new Date(createdAt.getTime() + 30_000);
      const closedAt = phase === 'closed'
        ? new Date(createdAt.getTime() + 150_000)
        : null;
      const terminalServerSequence = phase === 'closed'
        ? (withChildren ? 2 : 0)
        : null;
      const nextServerSequence = withChildren ? 3 : 1;
      const retainedFromServerSequence = withChildren ? 0 : 1;
      const acknowledgedServerSequence = retainedFromServerSequence;
      const missionState = {
        phase,
        sessionHandle,
        missionConnectionEpoch: 1,
        expiresAt: hardExpiresAt.toISOString(),
        contextRevision: 1,
        contextDigest,
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 320,
        audioBytes: 0,
        ...(phase === 'closed' ? { drainReason: 'user' } : {}),
      };

      // Les fixtures restent explicitement tenant-scopées même quand la connexion de setup est
      // superuser : la certification ne doit jamais dépendre d'un contexte implicite ou résiduel.
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${tenantId}, true)`;

      if (withChildren) {
        // La suspension précède tout DML : PostgreSQL refuse justement un ALTER TABLE dès qu'un
        // constraint-trigger différé est en attente. Les gardes cryptographiques et toutes les
        // contraintes/FK restent actives ; seuls les trois gardes métier qui interdisent de
        // recréer aujourd'hui une preuve déjà arrivée après G sont suspendus.
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_outbox DISABLE TRIGGER realtime_mistral_conversation_outbox_insert_guard',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_commands DISABLE TRIGGER realtime_mistral_conversation_command_insert_guard',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_resume_tickets DISABLE TRIGGER realtime_mistral_conversation_resume_ticket_insert_guard',
        );
      }
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');

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
          ${bootstrapId}::uuid, ${tenantId}, ${admissionSessionId}::uuid, ${sessionHandle},
          ${subjectHash}, 1, ${digest(`lease:${label}`)}, ${digest(`ticket:${label}`)},
          'bob.mistral-pcm.v2', 'consumed', 'pro', 1, 1,
          ${JSON.stringify({ version: 1, revision: 1, context: {} })}::jsonb,
          ${contextDigest}, decode('aa', 'hex'), decode(repeat('11', 12), 'hex'),
          decode(repeat('22', 16), 'hex'), ${identityKeyVersion}, 'push_to_talk', false, 320,
          ${createdAt}, ${ticketExpiresAt}, ${leaseExpiresAt}, ${hardExpiresAt}, ${consumedAt},
          ${retentionExpiresAt}, 2, ${consumedAt}
        )
      `;
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_missions (
          id, "companyId", "initialBootstrapId", "admissionSessionId", protocol,
          "subjectHash", "subjectKeyVersion", plan, "sessionHandle", "ownerTokenHash",
          "ownerAcquiredAt", "missionConnectionEpoch", version,
          "acknowledgedServerSequence", "retainedFromServerSequence", "nextServerSequence",
          "nextProviderSequence", "snapshotSchemaVersion", phase, "contextRevision",
          "contextDigest", "routeMode", "fullDuplexCertified", "maxMissionAudioBytes",
          "audioBytes", "missionState", "turnState", "finalTranscriptRecorded",
          "terminalReason", "terminalServerSequence", "closedAt", "hardExpiresAt",
          "replayGraceExpiresAt", "retentionExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${missionId}::uuid, ${tenantId}, ${bootstrapId}::uuid,
          ${admissionSessionId}::uuid, 'bob.mistral-pcm.v2', ${subjectHash}, 1, 'pro',
          ${sessionHandle}, ${digest(`owner:${label}`)},
          ${new Date(createdAt.getTime() + 1_000)}, 1, ${phase === 'closed' ? 2 : 1},
          ${acknowledgedServerSequence}, ${retainedFromServerSequence}, ${nextServerSequence},
          0, 1, ${phase}, 1, ${contextDigest}, 'push_to_talk', false, 320, 0,
          ${JSON.stringify(missionState)}::jsonb, NULL, false,
          ${phase === 'closed' ? 'user' : null}, ${terminalServerSequence}, ${closedAt},
          ${hardExpiresAt}, ${replayGraceExpiresAt}, ${retentionExpiresAt}, ${createdAt},
          ${closedAt ?? createdAt}
        )
      `;

      if (withChildren) {
        // Ces lignes représentent un héritage historique arrivé à rétention. Elles restent
        // constraint/FK-valides ; la validation différée est forcée avant de réarmer les gardes.
        await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_outbox (
              "companyId", "missionId", "sessionHandle", "serverSequence", "eventType",
              "payloadCiphertext", "payloadNonce", "payloadTag", "encryptionKeyVersion",
              "payloadBytes", "createdAt", "retentionExpiresAt"
            ) VALUES
              (${tenantId}, ${missionId}::uuid, ${sessionHandle}, 0, 'session.ready',
               decode('aa', 'hex'), decode(repeat('33', 12), 'hex'),
               decode(repeat('44', 16), 'hex'), ${persistenceKeyVersion}, 1,
               ${new Date(createdAt.getTime() + 10_000)}, ${retentionExpiresAt}),
              (${tenantId}, ${missionId}::uuid, ${sessionHandle}, 1, 'session.draining',
               decode('bb', 'hex'), decode(repeat('55', 12), 'hex'),
               decode(repeat('66', 16), 'hex'), ${persistenceKeyVersion}, 1,
               ${new Date(createdAt.getTime() + 140_000)}, ${retentionExpiresAt}),
              (${tenantId}, ${missionId}::uuid, ${sessionHandle}, 2, 'session.closed',
               decode('cc', 'hex'), decode(repeat('77', 12), 'hex'),
               decode(repeat('88', 16), 'hex'), ${persistenceKeyVersion}, 1,
               ${new Date(createdAt.getTime() + 150_000)}, ${retentionExpiresAt})
          `;
        await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_commands (
              "companyId", "missionId", "sessionHandle", "commandIdHash", "commandType",
              "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch",
              "snapshotVersionBefore", "snapshotVersionAfter", "firstServerSequence",
              "eventCount", "createdAt", "retentionExpiresAt"
            ) VALUES (
              ${tenantId}, ${missionId}::uuid, ${sessionHandle}, ${digest(`command:${label}`)},
              'close', ${digest(`command-proof:${label}`)}, ${persistenceKeyVersion}, 1,
              1, 2, 1, 2, ${new Date(createdAt.getTime() + 150_000)}, ${retentionExpiresAt}
            )
          `;
        await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_resume_tickets (
              id, "companyId", "missionId", "sessionHandle", "admissionSessionId",
              "ticketHash", protocol, scope, state, "subjectHash", "subjectKeyVersion", plan,
              "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
              "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
              "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
              "replayGraceExpiresAt", "issuedAt", "expiresAt", "retentionExpiresAt", version
            ) VALUES (
              ${randomUUID()}::uuid, ${tenantId}, ${missionId}::uuid, ${sessionHandle},
              ${admissionSessionId}::uuid, ${digest(`resume:${label}`)}, 'bob.mistral-pcm.v2',
              'terminal_replay', 'issued', ${subjectHash}, 1, 'pro', 1, 1, 0, 1,
              ${contextDigest}, 'push_to_talk', false, 320, ${hardExpiresAt},
              ${replayGraceExpiresAt}, ${new Date(createdAt.getTime() + 20_000)},
              ${new Date(createdAt.getTime() + 50_000)}, ${retentionExpiresAt}, 1
            )
          `;
      }

      if (options.withLease) {
        await tx.$executeRaw`
          INSERT INTO realtime_admission_events (
            id, "companyId", "subjectHash", "sessionId", "admittedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantId}, ${subjectHash},
            ${admissionSessionId}::uuid, clock_timestamp()
          )
        `;
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "providerId", "providerCallId", "reservedAt", "leaseExpiresAt",
            "hardExpiresAt", "activatedAt", "updatedAt"
          ) VALUES (
            ${tenantId}, ${subjectHash}, ${admissionSessionId}::uuid,
            ${digest(`admission-lease:${label}`)}, 'active', 'mistral',
            ${`mcv2:${bootstrapId}`}, clock_timestamp() - interval '1 second',
            clock_timestamp() + interval '60 seconds',
            clock_timestamp() + interval '120 seconds', clock_timestamp(), clock_timestamp()
          )
        `;
      }

      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      if (withChildren) {
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_resume_tickets ENABLE TRIGGER realtime_mistral_conversation_resume_ticket_insert_guard',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_commands ENABLE TRIGGER realtime_mistral_conversation_command_insert_guard',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_outbox ENABLE TRIGGER realtime_mistral_conversation_outbox_insert_guard',
        );
      }
      return {
        bootstrapId,
        missionId,
        companyId: tenantId,
        admissionSessionId,
        sessionHandle,
        subjectHash,
        retentionExpiresAt,
      };
    }

    async function counts(fixture: RetentionFixture): Promise<RetentionCounts> {
      const [row] = await setup.$queryRaw<RetentionCounts[]>`
        SELECT
          (SELECT count(*)::int FROM realtime_mistral_conversation_bootstrap_tickets
            WHERE id = ${fixture.bootstrapId}::uuid
              AND "companyId" = ${fixture.companyId}) AS bootstraps,
          (SELECT count(*)::int FROM realtime_mistral_conversation_missions
            WHERE id = ${fixture.missionId}::uuid
              AND "companyId" = ${fixture.companyId}) AS missions,
          (SELECT count(*)::int FROM realtime_mistral_conversation_terminal_receipts
            WHERE "companyId" = ${fixture.companyId}
              AND "sessionHandle" = ${fixture.sessionHandle}) AS receipts,
          (SELECT count(*)::int FROM realtime_mistral_conversation_resume_tickets
            WHERE "missionId" = ${fixture.missionId}::uuid
              AND "companyId" = ${fixture.companyId}) AS resumes,
          (SELECT count(*)::int FROM realtime_mistral_conversation_commands
            WHERE "missionId" = ${fixture.missionId}::uuid
              AND "companyId" = ${fixture.companyId}) AS commands,
          (SELECT count(*)::int FROM realtime_mistral_conversation_outbox
            WHERE "missionId" = ${fixture.missionId}::uuid
              AND "companyId" = ${fixture.companyId}) AS outbox,
          (SELECT count(*)::int FROM realtime_session_leases
            WHERE "sessionId" = ${fixture.admissionSessionId}::uuid
              AND "companyId" = ${fixture.companyId}) AS leases
      `;
      if (!row) throw new Error('Retention fixture evidence is unavailable.');
      return row;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      setup = new PrismaClient({ datasourceUrl: setupUrl });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl });
      runtime2 = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([
        admin.$connect(),
        setup.$connect(),
        runtime.$connect(),
        runtime2.$connect(),
      ]);

      const [persistenceFloor] = await admin.$queryRaw<Array<{ highestVersion: number }>>`
        SELECT "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-persistence-v1'
      `;
      const [identityFloor] = await admin.$queryRaw<Array<{ highestVersion: number }>>`
        SELECT "highestVersion"
          FROM realtime_mistral_conversation_identity_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-bootstrap-identity-v1'
      `;
      if (!Number.isInteger(persistenceFloor?.highestVersion)
        || !Number.isInteger(identityFloor?.highestVersion)) {
        throw new Error('Les registres de clés Mistral doivent être initialisés avant la cert.');
      }
      persistenceKeyVersion = persistenceFloor.highestVersion;
      identityKeyVersion = identityFloor.highestVersion;
      reaper = new PrismaMistralConversationBootstrapReaper(runtime);
      reaper2 = new PrismaMistralConversationBootstrapReaper(runtime2);
      for (const tenant of [company(companyId, 1), company(otherCompanyId, 2)]) {
        await setup.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_company_id', ${tenant.id}, true)`;
          await tx.company.create({ data: tenant });
        });
      }
    }, 30_000);

    afterAll(async () => {
      // La base de certification est jetable. Les cas impossibles aujourd'hui sont toujours
      // rollbackes avant de rendre la main, sans laisser de trigger désactivé ni de donnée future.
      await Promise.allSettled([
        ...(runtime ? [runtime.$disconnect()] : []),
        ...(runtime2 ? [runtime2.$disconnect()] : []),
        ...(admin ? [admin.$disconnect()] : []),
        ...(setup ? [setup.$disconnect()] : []),
      ]);
    });

    it('refuse une Mission closed avant les deux événements terminaux canoniques', async () => {
      try {
        await setup.$transaction((tx) => insertFixture(tx, 'closed-before-terminal-events', {
          phase: 'closed',
          withChildren: false,
        }));
        throw new Error('expected_terminal_mission_cursor_rejection');
      } catch (error) {
        expectPostgresError(
          error,
          '23514',
          'realtime_mistral_conversation_missions_terminal_cursor_check_v2',
        );
      }
    });

    it('n’expose au runtime que les fonctions SECURITY DEFINER, sans SET ROLE ni DELETE direct', async () => {
      const [runtimeAuthority] = await runtime.$queryRaw<Array<{
        roleName: string;
        isReaperMember: boolean;
        canSetReaperRole: boolean;
        canDeleteScopedTable: boolean;
        canTruncateScopedTable: boolean;
        canDeleteLease: boolean;
        canExecuteLegacy: boolean;
        canExecuteOrdered: boolean;
      }>>`
        SELECT current_user::text AS "roleName",
               pg_has_role(
                 current_user,
                 'bob_mistral_bootstrap_reaper',
                 'MEMBER'
               ) AS "isReaperMember",
               pg_has_role(
                 current_user,
                 'bob_mistral_bootstrap_reaper',
                 'SET'
               ) AS "canSetReaperRole",
               EXISTS (
                 SELECT 1
                   FROM (
                     VALUES
                       ('public.realtime_mistral_conversation_bootstrap_tickets'::text),
                       ('public.realtime_mistral_conversation_missions'::text),
                       ('public.realtime_mistral_conversation_resume_tickets'::text),
                       ('public.realtime_mistral_conversation_outbox'::text),
                       ('public.realtime_mistral_conversation_commands'::text),
                       ('public.realtime_mistral_conversation_terminal_receipts'::text)
                   ) AS scoped("tableName")
                  WHERE has_table_privilege(current_user, scoped."tableName", 'DELETE')
               ) AS "canDeleteScopedTable",
               EXISTS (
                 SELECT 1
                   FROM (
                     VALUES
                       ('public.realtime_mistral_conversation_bootstrap_tickets'::text),
                       ('public.realtime_mistral_conversation_missions'::text),
                       ('public.realtime_mistral_conversation_terminal_receipts'::text),
                       ('public.realtime_mistral_conversation_resume_tickets'::text),
                       ('public.realtime_mistral_conversation_outbox'::text),
                       ('public.realtime_mistral_conversation_commands'::text),
                       ('public.realtime_session_leases'::text)
                   ) AS scoped("tableName")
                  WHERE has_table_privilege(current_user, scoped."tableName", 'TRUNCATE')
               ) AS "canTruncateScopedTable",
               has_table_privilege(
                 current_user,
                 'public.realtime_session_leases',
                 'DELETE'
               ) AS "canDeleteLease",
               has_function_privilege(
                 current_user,
                 'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)',
                 'EXECUTE'
               ) AS "canExecuteLegacy",
               has_function_privilege(
                 current_user,
                 'public.purge_realtime_mistral_conversation_retention(integer)',
                 'EXECUTE'
               ) AS "canExecuteOrdered"
      `;
      expect(runtimeAuthority?.roleName).toBeTruthy();
      expect(runtimeAuthority?.roleName).not.toBe(REAPER_ROLE);
      expect(runtimeAuthority).toMatchObject({
        isReaperMember: false,
        canSetReaperRole: false,
        canDeleteScopedTable: false,
        canTruncateScopedTable: false,
        canDeleteLease: true,
        canExecuteLegacy: true,
        canExecuteOrdered: true,
      });

      const functions = await admin.$queryRaw<Array<{
        functionName: string;
        ownerName: string;
        securityDefiner: boolean;
        config: string[];
        publicExecuteRevoked: boolean;
      }>>`
        SELECT function.proname AS "functionName",
               owner.rolname AS "ownerName",
               function.prosecdef AS "securityDefiner",
               COALESCE(function.proconfig, ARRAY[]::text[]) AS config,
               NOT EXISTS (
                 SELECT 1
                   FROM aclexplode(
                     COALESCE(function.proacl, acldefault('f', function.proowner))
                   ) AS privilege
                  WHERE privilege.grantee = 0
                    AND privilege.privilege_type = 'EXECUTE'
               ) AS "publicExecuteRevoked"
          FROM pg_catalog.pg_proc AS function
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
         WHERE function.oid IN (
           'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
           'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
         )
         ORDER BY function.proname
      `;
      expect(functions).toHaveLength(2);
      for (const functionContract of functions) {
        expect(functionContract).toMatchObject({
          ownerName: REAPER_ROLE,
          securityDefiner: true,
          publicExecuteRevoked: true,
        });
        expect([...functionContract.config].sort()).toEqual([
          'row_security=on',
          'search_path=pg_catalog',
        ]);
      }

      const functionAcls = await admin.$queryRaw<Array<{
        functionName: string;
        granteeName: string;
        grantorName: string;
        privilegeType: string;
        isGrantable: boolean;
      }>>`
        SELECT function.proname AS "functionName",
               grantee.rolname AS "granteeName",
               grantor.rolname AS "grantorName",
               privilege.privilege_type AS "privilegeType",
               privilege.is_grantable AS "isGrantable"
          FROM pg_catalog.pg_proc AS function
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
         ) AS privilege
          JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
         WHERE function.oid IN (
           'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure,
           'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
         )
         ORDER BY function.proname, grantee.rolname
      `;
      expect(functionAcls).toHaveLength(4);
      expect(functionAcls).toEqual(expect.arrayContaining([
        {
          functionName: 'purge_realtime_mistral_conversation_bootstrap_tickets',
          granteeName: runtimeAuthority.roleName,
          grantorName: REAPER_ROLE,
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
        {
          functionName: 'purge_realtime_mistral_conversation_bootstrap_tickets',
          granteeName: REAPER_ROLE,
          grantorName: REAPER_ROLE,
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
        {
          functionName: 'purge_realtime_mistral_conversation_retention',
          granteeName: runtimeAuthority.roleName,
          grantorName: REAPER_ROLE,
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
        {
          functionName: 'purge_realtime_mistral_conversation_retention',
          granteeName: REAPER_ROLE,
          grantorName: REAPER_ROLE,
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
      ]));

      const [reaperSchema] = await admin.$queryRaw<Array<{
        canUseSchema: boolean;
        canCreateSchema: boolean;
      }>>`
        SELECT has_schema_privilege(${REAPER_ROLE}, 'public', 'USAGE') AS "canUseSchema",
               has_schema_privilege(${REAPER_ROLE}, 'public', 'CREATE') AS "canCreateSchema"
      `;
      expect(reaperSchema).toEqual({
        canUseSchema: true,
        canCreateSchema: false,
      });

      await expect(runtime.$transaction((tx) => tx.$executeRawUnsafe(
        `SET LOCAL ROLE ${REAPER_ROLE}`,
      ))).rejects.toThrow();
      await expect(runtime.$executeRaw`
        DELETE FROM realtime_mistral_conversation_missions WHERE false
      `).rejects.toThrow();

      const [directSweep] = await runtime.$queryRaw<Array<{
        bootstrapsPurged: number;
        expiredRowsRemain: boolean;
      }>>`
        SELECT retention.bootstraps_purged AS "bootstrapsPurged",
               retention.expired_rows_remain AS "expiredRowsRemain"
          FROM public.purge_realtime_mistral_conversation_retention(1) AS retention
      `;
      expect(Number.isInteger(directSweep?.bootstrapsPurged)).toBe(true);
      expect(typeof directSweep?.expiredRowsRemain).toBe('boolean');
      await expect(reaper.assertReady()).resolves.toBeUndefined();
    });

    it('refuse un membership ADMIN sans SET et le nettoie avant toute auto-escalade', async () => {
      const [runtimeIdentity] = await runtime.$queryRaw<Array<{ roleName: string }>>`
        SELECT current_user::text AS "roleName"
      `;
      if (!runtimeIdentity?.roleName) {
        throw new Error('Le rôle runtime doit être résolu avant la dérive de membership.');
      }
      const quotedRuntime = quoteIdentifier(runtimeIdentity.roleName);

      await admin.$executeRawUnsafe(
        `GRANT ${REAPER_ROLE} TO ${quotedRuntime} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      );
      try {
        const [before] = await admin.$queryRaw<Array<{
          runtimeIsReaperMember: boolean;
          runtimeCanSetReaper: boolean;
          directAdminOption: boolean;
          directSetOption: boolean;
        }>>`
          SELECT pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'MEMBER')
                   AS "runtimeIsReaperMember",
                 pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'SET')
                   AS "runtimeCanSetReaper",
                 COALESCE(bool_or(membership.admin_option), false)
                   AS "directAdminOption",
                 COALESCE(bool_or(membership.set_option), false)
                   AS "directSetOption"
            FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = ${REAPER_ROLE}::regrole
             AND membership.member = ${runtimeIdentity.roleName}::regrole
        `;
        expect(before).toEqual({
          runtimeIsReaperMember: true,
          runtimeCanSetReaper: false,
          directAdminOption: true,
          directSetOption: false,
        });
        await expect(reaper.assertReady()).rejects.toThrow(
          'Mistral conversation bootstrap reaper authority is unavailable.',
        );

        // PostgreSQL autorise un membre ADMIN à se réaccorder SET : MEMBER est donc un verrou
        // distinct de SET, même quand le runtime ne peut pas encore endosser le rôle.
        await runtime.$executeRawUnsafe(
          `GRANT ${REAPER_ROLE} TO ${quotedRuntime} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        const [escalated] = await runtime.$queryRaw<Array<{
          runtimeIsReaperMember: boolean;
          runtimeCanSetReaper: boolean;
        }>>`
          SELECT pg_has_role(current_user, ${REAPER_ROLE}, 'MEMBER')
                   AS "runtimeIsReaperMember",
                 pg_has_role(current_user, ${REAPER_ROLE}, 'SET')
                   AS "runtimeCanSetReaper"
        `;
        expect(escalated).toEqual({
          runtimeIsReaperMember: true,
          runtimeCanSetReaper: true,
        });

        replayReaperProvisioning(runtimeUrl, directUrl);

        const [after] = await admin.$queryRaw<Array<{
          runtimeIsReaperMember: boolean;
          runtimeCanSetReaper: boolean;
          directMembershipExists: boolean;
        }>>`
          SELECT pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'MEMBER')
                   AS "runtimeIsReaperMember",
                 pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'SET')
                   AS "runtimeCanSetReaper",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_auth_members AS membership
                    WHERE membership.roleid = ${REAPER_ROLE}::regrole
                      AND membership.member = ${runtimeIdentity.roleName}::regrole
                 ) AS "directMembershipExists"
        `;
        expect(after).toEqual({
          runtimeIsReaperMember: false,
          runtimeCanSetReaper: false,
          directMembershipExists: false,
        });
        await expect(reaper.assertReady()).resolves.toBeUndefined();
        await expect(runtime.$transaction((tx) => tx.$executeRawUnsafe(
          `SET LOCAL ROLE ${REAPER_ROLE}`,
        ))).rejects.toThrow();
      } finally {
        await admin.$executeRawUnsafe(
          `REVOKE ${REAPER_ROLE} FROM ${quotedRuntime} CASCADE`,
        );
      }
    });

    it('nettoie au rejeu un EXECUTE tiers et un chemin SET ROLE transitif', async () => {
      const [runtimeIdentity] = await runtime.$queryRaw<Array<{ roleName: string }>>`
        SELECT current_user::text AS "roleName"
      `;
      if (!runtimeIdentity?.roleName) {
        throw new Error('Le rôle runtime doit être résolu avant la dérive ACL.');
      }
      const delegatorRole = `bob_mcv2_acl_a_${suffix.slice(0, 22)}`;
      const delegateRole = `bob_mcv2_acl_b_${suffix.slice(0, 22)}`;
      const quotedDelegator = quoteIdentifier(delegatorRole);
      const quotedDelegate = quoteIdentifier(delegateRole);
      const quotedRuntime = quoteIdentifier(runtimeIdentity.roleName);

      await admin.$executeRawUnsafe(
        `CREATE ROLE ${quotedDelegator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await admin.$executeRawUnsafe(
        `CREATE ROLE ${quotedDelegate} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      try {
        await admin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
          await tx.$executeRawUnsafe(
            `GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(integer) TO ${quotedDelegator} WITH GRANT OPTION`,
          );
          await tx.$executeRawUnsafe(
            `GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(integer) TO ${quotedDelegator} WITH GRANT OPTION`,
          );
          await tx.$executeRawUnsafe(
            `GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(integer) TO ${quotedRuntime} WITH GRANT OPTION`,
          );
        });
        await admin.$executeRawUnsafe(
          `GRANT ${quotedDelegator} TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        await admin.$executeRawUnsafe(
          `GRANT DELETE ON TABLE public.realtime_mistral_conversation_bootstrap_tickets TO ${quotedDelegator} WITH GRANT OPTION`,
        );
        await admin.$executeRawUnsafe(
          `GRANT SELECT (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets TO ${quotedDelegator} WITH GRANT OPTION`,
        );
        await admin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quotedDelegator}`);
          await tx.$executeRawUnsafe(
            `GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(integer) TO ${quotedDelegate}`,
          );
          await tx.$executeRawUnsafe(
            'GRANT DELETE ON TABLE public.realtime_mistral_conversation_bootstrap_tickets TO PUBLIC',
          );
          await tx.$executeRawUnsafe(
            'GRANT SELECT (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets TO PUBLIC',
          );
        });
        await runtime.$executeRawUnsafe(
          `GRANT EXECUTE ON FUNCTION public.purge_realtime_mistral_conversation_retention(integer) TO ${quotedDelegate}`,
        );
        await admin.$executeRawUnsafe(
          `GRANT ${REAPER_ROLE} TO ${quotedDelegator} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        await admin.$executeRawUnsafe(
          `GRANT ${quotedDelegator} TO ${quotedRuntime} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        await admin.$executeRawUnsafe(
          `GRANT UPDATE ("terminalReason") ON TABLE public.realtime_mistral_conversation_terminal_receipts TO ${REAPER_ROLE}`,
        );

        const [before] = await admin.$queryRaw<Array<{
          runtimeIsReaperMember: boolean;
          runtimeCanSetReaper: boolean;
          delegatorCanExecute: boolean;
          delegateCanExecute: boolean;
          publicCanDelete: boolean;
          publicCanSelectColumn: boolean;
          delegatorCanDelete: boolean;
          delegatorDeleteIsGrantable: boolean;
          delegatorCanSelectColumn: boolean;
          delegatorColumnIsGrantable: boolean;
          reaperCanUpdateReceipt: boolean;
        }>>`
          SELECT pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'MEMBER')
                   AS "runtimeIsReaperMember",
                 pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'SET')
                   AS "runtimeCanSetReaper",
                 has_function_privilege(
                   ${delegatorRole},
                   'public.purge_realtime_mistral_conversation_retention(integer)',
                   'EXECUTE'
                 ) AS "delegatorCanExecute",
                 has_function_privilege(
                   ${delegateRole},
                   'public.purge_realtime_mistral_conversation_retention(integer)',
                   'EXECUTE'
                 ) AS "delegateCanExecute",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_class AS target
                    CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
                    WHERE target.oid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND privilege.grantee = 0
                      AND privilege.privilege_type = 'DELETE'
                 ) AS "publicCanDelete",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_attribute AS attribute
                    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
                    WHERE attribute.attrelid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND attribute.attname = 'id'
                      AND privilege.grantee = 0
                      AND privilege.privilege_type = 'SELECT'
                 ) AS "publicCanSelectColumn",
                 has_table_privilege(
                   ${delegatorRole},
                   'public.realtime_mistral_conversation_bootstrap_tickets',
                   'DELETE'
                 ) AS "delegatorCanDelete",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_class AS target
                    CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
                    WHERE target.oid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND privilege.grantee = ${delegatorRole}::regrole
                      AND privilege.privilege_type = 'DELETE'
                      AND privilege.is_grantable
                 ) AS "delegatorDeleteIsGrantable",
                 has_column_privilege(
                   ${delegatorRole},
                   'public.realtime_mistral_conversation_bootstrap_tickets',
                   'id',
                   'SELECT'
                 ) AS "delegatorCanSelectColumn",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_attribute AS attribute
                    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
                    WHERE attribute.attrelid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND attribute.attname = 'id'
                      AND privilege.grantee = ${delegatorRole}::regrole
                      AND privilege.privilege_type = 'SELECT'
                      AND privilege.is_grantable
                 ) AS "delegatorColumnIsGrantable",
                 has_column_privilege(
                   ${REAPER_ROLE},
                   'public.realtime_mistral_conversation_terminal_receipts',
                   'terminalReason',
                   'UPDATE'
                 ) AS "reaperCanUpdateReceipt"
        `;
        expect(before).toEqual({
          runtimeIsReaperMember: true,
          runtimeCanSetReaper: true,
          delegatorCanExecute: true,
          delegateCanExecute: true,
          publicCanDelete: true,
          publicCanSelectColumn: true,
          delegatorCanDelete: true,
          delegatorDeleteIsGrantable: true,
          delegatorCanSelectColumn: true,
          delegatorColumnIsGrantable: true,
          reaperCanUpdateReceipt: true,
        });
        await expect(reaper.assertReady()).rejects.toThrow(
          'Mistral conversation bootstrap reaper authority is unavailable.',
        );

        replayReaperProvisioning(runtimeUrl, directUrl);

        const [after] = await admin.$queryRaw<Array<{
          runtimeIsReaperMember: boolean;
          runtimeCanSetReaper: boolean;
          delegatorCanExecute: boolean;
          delegateCanExecute: boolean;
          publicCanDelete: boolean;
          publicCanSelectColumn: boolean;
          delegatorCanDelete: boolean;
          delegatorDeleteIsGrantable: boolean;
          delegatorCanSelectColumn: boolean;
          delegatorColumnIsGrantable: boolean;
          reaperCanUpdateReceipt: boolean;
        }>>`
          SELECT pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'MEMBER')
                   AS "runtimeIsReaperMember",
                 pg_has_role(${runtimeIdentity.roleName}, ${REAPER_ROLE}, 'SET')
                   AS "runtimeCanSetReaper",
                 has_function_privilege(
                   ${delegatorRole},
                   'public.purge_realtime_mistral_conversation_retention(integer)',
                   'EXECUTE'
                 ) AS "delegatorCanExecute",
                 has_function_privilege(
                   ${delegateRole},
                   'public.purge_realtime_mistral_conversation_retention(integer)',
                   'EXECUTE'
                 ) AS "delegateCanExecute",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_class AS target
                    CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
                    WHERE target.oid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND privilege.grantee = 0
                      AND privilege.privilege_type = 'DELETE'
                 ) AS "publicCanDelete",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_attribute AS attribute
                    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
                    WHERE attribute.attrelid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND attribute.attname = 'id'
                      AND privilege.grantee = 0
                      AND privilege.privilege_type = 'SELECT'
                 ) AS "publicCanSelectColumn",
                 has_table_privilege(
                   ${delegatorRole},
                   'public.realtime_mistral_conversation_bootstrap_tickets',
                   'DELETE'
                 ) AS "delegatorCanDelete",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_class AS target
                    CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
                    WHERE target.oid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND privilege.grantee = ${delegatorRole}::regrole
                      AND privilege.privilege_type = 'DELETE'
                      AND privilege.is_grantable
                 ) AS "delegatorDeleteIsGrantable",
                 has_column_privilege(
                   ${delegatorRole},
                   'public.realtime_mistral_conversation_bootstrap_tickets',
                   'id',
                   'SELECT'
                 ) AS "delegatorCanSelectColumn",
                 EXISTS (
                   SELECT 1
                     FROM pg_catalog.pg_attribute AS attribute
                    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
                    WHERE attribute.attrelid =
                      'public.realtime_mistral_conversation_bootstrap_tickets'::regclass
                      AND attribute.attname = 'id'
                      AND privilege.grantee = ${delegatorRole}::regrole
                      AND privilege.privilege_type = 'SELECT'
                      AND privilege.is_grantable
                 ) AS "delegatorColumnIsGrantable",
                 has_column_privilege(
                   ${REAPER_ROLE},
                   'public.realtime_mistral_conversation_terminal_receipts',
                   'terminalReason',
                   'UPDATE'
                 ) AS "reaperCanUpdateReceipt"
        `;
        expect(after).toEqual({
          runtimeIsReaperMember: false,
          runtimeCanSetReaper: false,
          delegatorCanExecute: false,
          delegateCanExecute: false,
          publicCanDelete: false,
          publicCanSelectColumn: false,
          delegatorCanDelete: true,
          delegatorDeleteIsGrantable: false,
          delegatorCanSelectColumn: true,
          delegatorColumnIsGrantable: false,
          reaperCanUpdateReceipt: false,
        });
        await expect(reaper.assertReady()).resolves.toBeUndefined();
      } finally {
        await admin.$executeRawUnsafe(
          'REVOKE DELETE ON TABLE public.realtime_mistral_conversation_bootstrap_tickets FROM PUBLIC CASCADE',
        );
        await admin.$executeRawUnsafe(
          'REVOKE SELECT (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets FROM PUBLIC CASCADE',
        );
        await admin.$executeRawUnsafe(
          `REVOKE UPDATE ("terminalReason") ON TABLE public.realtime_mistral_conversation_terminal_receipts FROM ${REAPER_ROLE} CASCADE`,
        );
        await admin.$executeRawUnsafe(
          `REVOKE ALL PRIVILEGES ON TABLE public.realtime_mistral_conversation_bootstrap_tickets FROM ${quotedDelegator} CASCADE`,
        );
        await admin.$executeRawUnsafe(
          `REVOKE ALL PRIVILEGES (id) ON TABLE public.realtime_mistral_conversation_bootstrap_tickets FROM ${quotedDelegator} CASCADE`,
        );
        await admin.$executeRawUnsafe(`REVOKE ${quotedDelegator} FROM ${quotedRuntime}`);
        await admin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
          await tx.$executeRawUnsafe(
            `REVOKE ALL PRIVILEGES ON FUNCTION public.purge_realtime_mistral_conversation_bootstrap_tickets(integer) FROM ${quotedDelegator} CASCADE`,
          );
          await tx.$executeRawUnsafe(
            `REVOKE ALL PRIVILEGES ON FUNCTION public.purge_realtime_mistral_conversation_retention(integer) FROM ${quotedDelegator} CASCADE`,
          );
        });
        await admin.$executeRawUnsafe(`REVOKE ${REAPER_ROLE} FROM ${quotedDelegator}`);
        await admin.$executeRawUnsafe(`DROP ROLE ${quotedDelegate}`);
        await admin.$executeRawUnsafe(`DROP ROLE ${quotedDelegator}`);
      }
    });

    it('certifie le reçu terminal minimal, tenant-readable, immuable et sans privilège de mutation runtime/reaper', async () => {
      const [schema] = await setup.$queryRaw<Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        foreignKey: string;
      }>>`
        SELECT receipt.relrowsecurity AS "rlsEnabled",
               receipt.relforcerowsecurity AS "rlsForced",
               pg_get_constraintdef(company_fk.oid) AS "foreignKey"
          FROM pg_class AS receipt
          JOIN pg_namespace AS namespace ON namespace.oid = receipt.relnamespace
          JOIN pg_constraint AS company_fk
            ON company_fk.conrelid = receipt.oid
           AND company_fk.conname = 'mistral_terminal_receipt_company_fkey'
         WHERE namespace.nspname = 'public'
           AND receipt.relname = 'realtime_mistral_conversation_terminal_receipts'
      `;
      expect(schema).toEqual({
        rlsEnabled: true,
        rlsForced: true,
        foreignKey: 'FOREIGN KEY ("companyId") REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE',
      });

      const [runtimePrivileges] = await runtime.$queryRaw<Array<{
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
        canReferences: boolean;
        canTrigger: boolean;
      }>>`
        SELECT has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'SELECT'
               ) AS "canSelect",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'INSERT'
               ) AS "canInsert",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'UPDATE'
               ) AS "canUpdate",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'DELETE'
               ) AS "canDelete",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'TRUNCATE'
               ) AS "canTruncate",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'REFERENCES'
               ) AS "canReferences",
               has_table_privilege(
                 current_user,
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'TRIGGER'
               ) AS "canTrigger"
      `;
      expect(runtimePrivileges).toEqual({
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
      });

      const reaperColumns = await setup.$queryRaw<Array<{ columnName: string }>>`
        SELECT privilege.column_name AS "columnName"
          FROM information_schema.column_privileges AS privilege
         WHERE privilege.table_schema = 'public'
           AND privilege.table_name = 'realtime_mistral_conversation_terminal_receipts'
           AND privilege.grantee = ${REAPER_ROLE}
           AND privilege.privilege_type = 'SELECT'
      `;
      expect(reaperColumns.map(({ columnName }) => columnName).sort()).toEqual([
        'closedAt',
        'companyId',
        'missionConnectionEpoch',
        'nextServerSequence',
        'protocol',
        'sessionHandle',
        'subjectHash',
        'subjectKeyVersion',
        'terminalReason',
      ].sort());
      const [reaperPrivileges] = await setup.$queryRaw<Array<{
        tableSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
      }>>`
        SELECT has_table_privilege(
                 ${REAPER_ROLE},
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'SELECT'
               ) AS "tableSelect",
               has_table_privilege(
                 ${REAPER_ROLE},
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'INSERT'
               ) AS "canInsert",
               has_table_privilege(
                 ${REAPER_ROLE},
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'UPDATE'
               ) AS "canUpdate",
               has_table_privilege(
                 ${REAPER_ROLE},
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'DELETE'
               ) AS "canDelete",
               has_table_privilege(
                 ${REAPER_ROLE},
                 'public.realtime_mistral_conversation_terminal_receipts',
                 'TRUNCATE'
               ) AS "canTruncate"
      `;
      expect(reaperPrivileges).toEqual({
        tableSelect: false,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      });

      try {
        await setup.$executeRaw`
          INSERT INTO realtime_mistral_conversation_terminal_receipts (
            "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
            "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
          ) VALUES (
            ${companyId}, ${randomUUID()}, ${digest('invalid-terminal-cursor')}, 1,
            'bob.mistral-pcm.v2', 1, 1, 'user', clock_timestamp()
          )
        `;
        throw new Error('expected_terminal_receipt_cursor_rejection');
      } catch (error) {
        expectPostgresError(error, '23514', 'mistral_terminal_receipt_cursor_check');
      }

      const fixture = await setup.$transaction((tx) => insertFixture(
        tx,
        'tenant-readable-terminal-receipt',
      ));
      const ownReceipt = await runtime.withTenant(companyId, (tx) => tx.$queryRaw<Array<{
        companyId: string;
        sessionHandle: string;
        subjectHash: string;
        subjectKeyVersion: number;
        protocol: string;
        missionConnectionEpoch: number;
        nextServerSequence: bigint;
        terminalReason: string;
        closedAt: Date;
      }>>`
        SELECT "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
               "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
          FROM realtime_mistral_conversation_terminal_receipts
         WHERE "companyId" = ${fixture.companyId}
           AND "sessionHandle" = ${fixture.sessionHandle}
      `);
      expect(ownReceipt).toEqual([expect.objectContaining({
        companyId: fixture.companyId,
        sessionHandle: fixture.sessionHandle,
        subjectHash: fixture.subjectHash,
        subjectKeyVersion: 1,
        protocol: 'bob.mistral-pcm.v2',
        missionConnectionEpoch: 1,
        nextServerSequence: 3n,
        terminalReason: 'user',
        closedAt: expect.any(Date),
      })]);
      await expect(runtime.withTenant(otherCompanyId, (tx) => tx.$queryRaw`
        SELECT "companyId"
          FROM realtime_mistral_conversation_terminal_receipts
         WHERE "companyId" = ${fixture.companyId}
           AND "sessionHandle" = ${fixture.sessionHandle}
      `)).resolves.toEqual([]);

      try {
        await runtime.withTenant(companyId, (tx) => tx.$executeRaw`
          DELETE FROM realtime_mistral_conversation_terminal_receipts
           WHERE "companyId" = ${fixture.companyId}
             AND "sessionHandle" = ${fixture.sessionHandle}
        `);
        throw new Error('expected_runtime_terminal_receipt_delete_rejection');
      } catch (error) {
        expectPostgresError(error, '42501', 'permission denied');
      }
      for (const mutation of [
        () => setup.$executeRaw`
          UPDATE realtime_mistral_conversation_terminal_receipts
             SET "terminalReason" = 'expired'
           WHERE "companyId" = ${fixture.companyId}
             AND "sessionHandle" = ${fixture.sessionHandle}
        `,
        () => setup.$executeRaw`
          DELETE FROM realtime_mistral_conversation_terminal_receipts
           WHERE "companyId" = ${fixture.companyId}
             AND "sessionHandle" = ${fixture.sessionHandle}
        `,
        () => setup.$executeRawUnsafe(
          'TRUNCATE TABLE realtime_mistral_conversation_terminal_receipts',
        ),
      ]) {
        try {
          await mutation();
          throw new Error('expected_terminal_receipt_immutability_rejection');
        } catch (error) {
          expectPostgresError(error, '55000', 'terminal receipt is immutable');
        }
      }

      const purged = await reaper.purgeBatch(100);
      expect(purged).toMatchObject({ missionsPurged: 1, bootstrapsPurged: 1 });
      expect(await counts(fixture)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
      await expect(runtime.withTenant(companyId, (tx) => tx.$queryRaw`
        SELECT "terminalReason", "nextServerSequence"
          FROM realtime_mistral_conversation_terminal_receipts
         WHERE "companyId" = ${fixture.companyId}
           AND "sessionHandle" = ${fixture.sessionHandle}
      `)).resolves.toEqual([{ terminalReason: 'user', nextServerSequence: 3n }]);

      const cascadeCompanyId = `mcv2-retention-cascade-${suffix}`;
      await setup.company.create({ data: company(cascadeCompanyId, 3) });
      const cascadeFixture = await setup.$transaction((tx) => insertFixture(
        tx,
        'company-cascade-terminal-receipt',
        { companyId: cascadeCompanyId },
      ));
      expect((await reaper.purgeBatch(100)).missionsPurged).toBe(1);
      expect((await counts(cascadeFixture)).receipts).toBe(1);

      await setup.company.delete({ where: { id: cascadeCompanyId } });
      const [afterCompanyCascade] = await setup.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_mistral_conversation_terminal_receipts
         WHERE "companyId" = ${cascadeCompanyId}
           AND "sessionHandle" = ${cascadeFixture.sessionHandle}
      `;
      expect(afterCompanyCascade?.count).toBe(0);
    });

    it('certifie la FK composite validée et refuse une Mission liée au bootstrap d’un autre tenant', async () => {
      const [constraint] = await setup.$queryRaw<Array<{
        validated: boolean;
        definition: string;
      }>>`
        SELECT convalidated AS validated,
               pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conname = 'mistral_conversation_mission_bootstrap_fkey'
           AND conrelid = 'realtime_mistral_conversation_missions'::regclass
      `;
      expect(constraint?.validated).toBe(true);
      expect(constraint?.definition).toContain(
        'FOREIGN KEY ("initialBootstrapId", "companyId")',
      );
      expect(constraint?.definition).toContain('ON UPDATE CASCADE ON DELETE RESTRICT');

      try {
        await setup.$transaction(async (tx) => {
          const fixture = await insertFixture(tx, 'cross-tenant-fk');
          await tx.$executeRaw`
            WITH source AS (
              DELETE FROM realtime_mistral_conversation_missions
               WHERE id = ${fixture.missionId}::uuid
                 AND "companyId" = ${companyId}
              RETURNING *
            )
            INSERT INTO realtime_mistral_conversation_missions (
              id, "companyId", "initialBootstrapId", "admissionSessionId", protocol,
              "subjectHash", "subjectKeyVersion", plan, "sessionHandle", "ownerTokenHash",
              "ownerAcquiredAt", "missionConnectionEpoch", version,
              "acknowledgedServerSequence", "retainedFromServerSequence", "nextServerSequence",
              "nextProviderSequence", "snapshotSchemaVersion", phase, "contextRevision",
              "contextDigest", "routeMode", "fullDuplexCertified", "maxMissionAudioBytes",
              "audioBytes", "missionState", "turnState", "finalTranscriptRecorded",
              "terminalReason", "terminalServerSequence", "closedAt", "hardExpiresAt",
              "replayGraceExpiresAt", "retentionExpiresAt", "createdAt", "updatedAt"
            )
            SELECT
              ${randomUUID()}::uuid, ${otherCompanyId}, source."initialBootstrapId",
              source."admissionSessionId", source.protocol, source."subjectHash",
              source."subjectKeyVersion", source.plan, source."sessionHandle",
              ${digest('cross-tenant-owner')}, source."ownerAcquiredAt",
              source."missionConnectionEpoch", source.version,
              source."acknowledgedServerSequence", source."retainedFromServerSequence",
              source."nextServerSequence", source."nextProviderSequence",
              source."snapshotSchemaVersion", source.phase, source."contextRevision",
              source."contextDigest", source."routeMode", source."fullDuplexCertified",
              source."maxMissionAudioBytes", source."audioBytes", source."missionState",
              source."turnState", source."finalTranscriptRecorded", source."terminalReason",
              source."terminalServerSequence", source."closedAt", source."hardExpiresAt",
              source."replayGraceExpiresAt", source."retentionExpiresAt", source."createdAt",
              source."updatedAt"
              FROM source
          `;
        });
        throw new Error('expected_cross_tenant_fk_rejection');
      } catch (error) {
        expectPostgresError(
          error,
          '23503',
          'mistral_conversation_mission_bootstrap_fkey',
        );
      }
    });

    it('préserve atomiquement un bootstrap expiré tant que sa Mission n’est pas terminale', async () => {
      await expect(setup.$transaction(async (tx) => {
        const fixture = await insertFixture(tx, 'non-terminal', { phase: 'ready' });
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
        const [result] = await tx.$queryRaw<Array<{
          missionsPurged: number;
          bootstrapsPurged: number;
          terminalizationBlocked: boolean;
          eligibleRootsRemain: boolean;
          expiredRowsRemain: boolean;
        }>>`
          SELECT retention.missions_purged AS "missionsPurged",
                 retention.bootstraps_purged AS "bootstrapsPurged",
                 retention.terminalization_blocked AS "terminalizationBlocked",
                 retention.eligible_roots_remain AS "eligibleRootsRemain",
                 retention.expired_rows_remain AS "expiredRowsRemain"
            FROM purge_realtime_mistral_conversation_retention(100) AS retention
        `;
        await tx.$executeRawUnsafe('RESET ROLE');
        const [preserved] = await tx.$queryRaw<Array<{
          bootstraps: number;
          missions: number;
        }>>`
          SELECT
            (SELECT count(*)::int
               FROM realtime_mistral_conversation_bootstrap_tickets
              WHERE id = ${fixture.bootstrapId}::uuid) AS bootstraps,
            (SELECT count(*)::int
               FROM realtime_mistral_conversation_missions
              WHERE id = ${fixture.missionId}::uuid) AS missions
        `;
        expect(result).toMatchObject({
          terminalizationBlocked: true,
          expiredRowsRemain: true,
        });
        expect(preserved).toEqual({ bootstraps: 1, missions: 1 });
        throw new RollbackCertificationFixture();
      })).rejects.toBeInstanceOf(RollbackCertificationFixture);
    });

    it('le purgeur bootstrap historique ne laisse pas une preuve consommée référencée affamer son batch', async () => {
      await expect(setup.$transaction(async (tx) => {
        const now = Date.now();
        const referenced = await insertFixture(tx, 'legacy-referenced-root', {
          phase: 'ready',
          withChildren: false,
          createdAt: new Date(now - 20 * 60_000),
        });
        const orphanId = randomUUID();
        const orphanAdmissionSessionId = randomUUID();
        const orphanCreatedAt = new Date(now - 10 * 60_000);
        const orphanTicketExpiresAt = new Date(orphanCreatedAt.getTime() + 60_000);
        const orphanLeaseExpiresAt = new Date(orphanCreatedAt.getTime() + 70_000);
        const orphanHardExpiresAt = new Date(orphanCreatedAt.getTime() + 120_000);
        const orphanRetentionExpiresAt = new Date(orphanCreatedAt.getTime() + 240_000);

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
            ${orphanId}::uuid, ${companyId}, ${orphanAdmissionSessionId}::uuid,
            ${orphanAdmissionSessionId}, ${digest('legacy-orphan-subject')}, 1,
            ${digest('legacy-orphan-lease')}, ${digest('legacy-orphan-ticket')},
            'bob.mistral-pcm.v2', 'issued', 'pro', 1, 1,
            ${JSON.stringify({ version: 1, revision: 1, context: {} })}::jsonb,
            ${digest('legacy-orphan-context')}, decode('aa', 'hex'),
            decode(repeat('11', 12), 'hex'), decode(repeat('22', 16), 'hex'),
            ${identityKeyVersion}, 'push_to_talk', false, 320, ${orphanCreatedAt},
            ${orphanTicketExpiresAt}, ${orphanLeaseExpiresAt}, ${orphanHardExpiresAt}, NULL,
            ${orphanRetentionExpiresAt}, 1, ${orphanCreatedAt}
          )
        `;

        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
        const [result] = await tx.$queryRaw<Array<{ purged: number }>>`
          SELECT purge_realtime_mistral_conversation_bootstrap_tickets(1) AS purged
        `;
        await tx.$executeRawUnsafe('RESET ROLE');
        const [remaining] = await tx.$queryRaw<Array<{
          referenced: boolean;
          orphan: boolean;
        }>>`
          SELECT EXISTS (
                   SELECT 1
                     FROM realtime_mistral_conversation_bootstrap_tickets
                    WHERE id = ${referenced.bootstrapId}::uuid
                 ) AS referenced,
                 EXISTS (
                   SELECT 1
                     FROM realtime_mistral_conversation_bootstrap_tickets
                    WHERE id = ${orphanId}::uuid
                 ) AS orphan
        `;

        expect(result?.purged).toBe(1);
        expect(remaining).toEqual({ referenced: true, orphan: false });
        throw new RollbackCertificationFixture();
      })).rejects.toBeInstanceOf(RollbackCertificationFixture);
    });

    it('attend la terminaison du lease, purge enfants puis Mission puis bootstrap, sans toucher à l’audit admission', async () => {
      const fixture = await setup.$transaction((tx) => insertFixture(
        tx,
        'admission-fence',
        { withChildren: true, withLease: true },
      ));

      const blocked = await reaper.purgeBatch(100);
      expect(blocked.admissionBlocked).toBeGreaterThanOrEqual(1);
      expect(blocked.eligibleRootsRemain).toBe(true);
      expect(blocked.expiredRowsRemain).toBe(true);
      expect(await counts(fixture)).toEqual({
        bootstraps: 1,
        missions: 1,
        receipts: 1,
        resumes: 1,
        commands: 1,
        outbox: 3,
        leases: 1,
      });

      const deletedLease = await runtime.withTenant(companyId, (tx) => tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${fixture.companyId}
           AND "subjectHash" = ${fixture.subjectHash}
           AND "sessionId" = ${fixture.admissionSessionId}::uuid
      `);
      expect(deletedLease).toBe(1);

      const purged = await reaper.purgeBatch(100);
      expect(purged.missionsPurged).toBeGreaterThanOrEqual(1);
      expect(purged.bootstrapsPurged).toBeGreaterThanOrEqual(1);
      expect(purged.resumeTicketsPurged).toBeGreaterThanOrEqual(1);
      expect(purged.commandsPurged).toBeGreaterThanOrEqual(1);
      expect(purged.outboxEventsPurged).toBeGreaterThanOrEqual(3);
      expect(await counts(fixture)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
      const [admissionAudit] = await setup.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_admission_events
         WHERE "companyId" = ${fixture.companyId}
           AND "sessionId" = ${fixture.admissionSessionId}::uuid
      `;
      expect(admissionAudit?.count).toBe(1);
    });

    it('voit et préserve un enfant futur au lieu de le masquer sous FORCE RLS puis CASCADE', async () => {
      await expect(setup.$transaction(async (tx) => {
        const fixture = await insertFixture(tx, 'future-child', { withChildren: true });
        await tx.$executeRawUnsafe(
          'ALTER TABLE realtime_mistral_conversation_commands DISABLE TRIGGER realtime_mistral_conversation_command_insert_guard',
        );
        try {
          await tx.$executeRaw`
            INSERT INTO realtime_mistral_conversation_commands (
              "companyId", "missionId", "sessionHandle", "commandIdHash", "commandType",
              "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch",
              "snapshotVersionBefore", "snapshotVersionAfter", "firstServerSequence",
              "eventCount", "createdAt", "retentionExpiresAt"
            )
            SELECT "companyId", "missionId", "sessionHandle", ${digest('future-command')},
                   "commandType", ${digest('future-command-proof')}, "proofKeyVersion",
                   "missionConnectionEpoch", "snapshotVersionBefore", "snapshotVersionAfter",
                   "firstServerSequence", "eventCount", "createdAt",
                   clock_timestamp() + interval '1 day'
              FROM realtime_mistral_conversation_commands
             WHERE "companyId" = ${fixture.companyId}
               AND "missionId" = ${fixture.missionId}::uuid
          `;
        } finally {
          await tx.$executeRawUnsafe(
            'ALTER TABLE realtime_mistral_conversation_commands ENABLE TRIGGER realtime_mistral_conversation_command_insert_guard',
          );
        }
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
        const [result] = await tx.$queryRaw<Array<{
          missionsPurged: number;
          bootstrapsPurged: number;
          invariantBlocked: number;
          eligibleRootsRemain: boolean;
        }>>`
          SELECT retention.missions_purged AS "missionsPurged",
                 retention.bootstraps_purged AS "bootstrapsPurged",
                 retention.invariant_blocked AS "invariantBlocked",
                 retention.eligible_roots_remain AS "eligibleRootsRemain"
            FROM purge_realtime_mistral_conversation_retention(100) AS retention
        `;
        await tx.$executeRawUnsafe('RESET ROLE');
        const [preserved] = await tx.$queryRaw<Array<RetentionCounts>>`
          SELECT
            (SELECT count(*)::int FROM realtime_mistral_conversation_bootstrap_tickets
              WHERE id = ${fixture.bootstrapId}::uuid) AS bootstraps,
            (SELECT count(*)::int FROM realtime_mistral_conversation_missions
              WHERE id = ${fixture.missionId}::uuid) AS missions,
            (SELECT count(*)::int FROM realtime_mistral_conversation_terminal_receipts
              WHERE "companyId" = ${fixture.companyId}
                AND "sessionHandle" = ${fixture.sessionHandle}) AS receipts,
            (SELECT count(*)::int FROM realtime_mistral_conversation_resume_tickets
              WHERE "missionId" = ${fixture.missionId}::uuid) AS resumes,
            (SELECT count(*)::int FROM realtime_mistral_conversation_commands
              WHERE "missionId" = ${fixture.missionId}::uuid) AS commands,
            (SELECT count(*)::int FROM realtime_mistral_conversation_outbox
              WHERE "missionId" = ${fixture.missionId}::uuid) AS outbox,
            (SELECT count(*)::int FROM realtime_session_leases
              WHERE "sessionId" = ${fixture.admissionSessionId}::uuid) AS leases
        `;
        expect(result).toEqual({
          missionsPurged: 0,
          bootstrapsPurged: 0,
          invariantBlocked: 1,
          eligibleRootsRemain: true,
        });
        expect(preserved).toEqual({
          bootstraps: 1,
          missions: 1,
          receipts: 1,
          resumes: 1,
          commands: 2,
          outbox: 3,
          leases: 0,
        });
        throw new RollbackCertificationFixture();
      })).rejects.toBeInstanceOf(RollbackCertificationFixture);
    });

    it.each(['absent', 'divergent'] as const)(
      'refuse toute purge quand le reçu terminal exact est %s',
      async (receiptState) => {
        await expect(setup.$transaction(async (tx) => {
          const fixture = await insertFixture(
            tx,
            `terminal-receipt-${receiptState}`,
            { withChildren: true },
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE realtime_mistral_conversation_terminal_receipts DISABLE TRIGGER realtime_mistral_terminal_receipt_immutable',
          );
          try {
            if (receiptState === 'absent') {
              await tx.$executeRaw`
                DELETE FROM realtime_mistral_conversation_terminal_receipts
                 WHERE "companyId" = ${fixture.companyId}
                   AND "sessionHandle" = ${fixture.sessionHandle}
              `;
            } else {
              await tx.$executeRaw`
                UPDATE realtime_mistral_conversation_terminal_receipts
                   SET "subjectHash" = ${digest('divergent-receipt-subject')}
                 WHERE "companyId" = ${fixture.companyId}
                   AND "sessionHandle" = ${fixture.sessionHandle}
              `;
            }
          } finally {
            await tx.$executeRawUnsafe(
              'ALTER TABLE realtime_mistral_conversation_terminal_receipts ENABLE TRIGGER realtime_mistral_terminal_receipt_immutable',
            );
          }

          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${REAPER_ROLE}`);
          const [result] = await tx.$queryRaw<Array<{
            missionsPurged: number;
            bootstrapsPurged: number;
            invariantBlocked: number;
            eligibleRootsRemain: boolean;
          }>>`
            SELECT retention.missions_purged AS "missionsPurged",
                   retention.bootstraps_purged AS "bootstrapsPurged",
                   retention.invariant_blocked AS "invariantBlocked",
                   retention.eligible_roots_remain AS "eligibleRootsRemain"
              FROM purge_realtime_mistral_conversation_retention(100) AS retention
          `;
          await tx.$executeRawUnsafe('RESET ROLE');
          const [preserved] = await tx.$queryRaw<Array<RetentionCounts>>`
            SELECT
              (SELECT count(*)::int FROM realtime_mistral_conversation_bootstrap_tickets
                WHERE id = ${fixture.bootstrapId}::uuid) AS bootstraps,
              (SELECT count(*)::int FROM realtime_mistral_conversation_missions
                WHERE id = ${fixture.missionId}::uuid) AS missions,
              (SELECT count(*)::int FROM realtime_mistral_conversation_terminal_receipts
                WHERE "companyId" = ${fixture.companyId}
                  AND "sessionHandle" = ${fixture.sessionHandle}) AS receipts,
              (SELECT count(*)::int FROM realtime_mistral_conversation_resume_tickets
                WHERE "missionId" = ${fixture.missionId}::uuid) AS resumes,
              (SELECT count(*)::int FROM realtime_mistral_conversation_commands
                WHERE "missionId" = ${fixture.missionId}::uuid) AS commands,
              (SELECT count(*)::int FROM realtime_mistral_conversation_outbox
                WHERE "missionId" = ${fixture.missionId}::uuid) AS outbox,
              (SELECT count(*)::int FROM realtime_session_leases
                WHERE "sessionId" = ${fixture.admissionSessionId}::uuid) AS leases
          `;
          expect(result).toEqual({
            missionsPurged: 0,
            bootstrapsPurged: 0,
            invariantBlocked: 1,
            eligibleRootsRemain: true,
          });
          expect(preserved).toEqual({
            bootstraps: 1,
            missions: 1,
            receipts: receiptState === 'absent' ? 0 : 1,
            resumes: 1,
            commands: 1,
            outbox: 3,
            leases: 0,
          });
          throw new RollbackCertificationFixture();
        })).rejects.toBeInstanceOf(RollbackCertificationFixture);
      },
    );

    it('ne laisse pas un préfixe empoisonné de plus de huit batches affamer une racine saine', async () => {
      const blockedCreatedAt = new Date(Date.now() - 30 * 60_000);
      const blocked = await setup.$transaction(async (tx) => {
        const fixtures: RetentionFixture[] = [];
        for (let index = 0; index < 9; index += 1) {
          fixtures.push(await insertFixture(
            tx,
            `poisoned-prefix-${index}`,
            { createdAt: blockedCreatedAt, withChildren: true, withLease: true },
          ));
        }
        return fixtures;
      });
      const healthy = await setup.$transaction((tx) => insertFixture(
        tx,
        'healthy-after-poisoned-prefix',
        { createdAt: new Date(Date.now() - 10 * 60_000), withChildren: true },
      ));

      const result = await reaper.purgeBatch(1);

      expect(result).toMatchObject({
        missionsPurged: 1,
        bootstrapsPurged: 1,
        admissionBlocked: 0,
        invariantBlocked: 0,
      });
      expect(await counts(healthy)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
      for (const fixture of blocked) {
        expect(await counts(fixture)).toMatchObject({
          bootstraps: 1,
          missions: 1,
          receipts: 1,
          leases: 1,
        });
      }

      const blockedAdmissionIds = Prisma.join(
        blocked.map(({ admissionSessionId }) => Prisma.sql`${admissionSessionId}::uuid`),
      );
      await runtime.withTenant(companyId, (tx) => tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "sessionId" IN (${blockedAdmissionIds})
      `);
      const cleanup = await reaper.purgeBatch(100);
      expect(cleanup.missionsPurged).toBeGreaterThanOrEqual(blocked.length);
      for (const fixture of blocked) {
        expect(await counts(fixture)).toMatchObject({
          bootstraps: 0,
          missions: 0,
          receipts: 1,
          leases: 0,
        });
      }
    }, 20_000);

    it('partage deux groupes entre deux répliques sans double purge ni blocage', async () => {
      const [first, second] = await setup.$transaction(async (tx) => {
        const firstFixture = await insertFixture(tx, 'concurrent-a', { withChildren: true });
        const secondFixture = await insertFixture(tx, 'concurrent-b', { withChildren: true });
        return [firstFixture, secondFixture] as const;
      });

      const [left, right] = await Promise.all([
        reaper.purgeBatch(1),
        reaper2.purgeBatch(1),
      ]);
      expect(left.missionsPurged + right.missionsPurged).toBe(2);
      expect(left.bootstrapsPurged + right.bootstrapsPurged).toBe(2);
      expect(left.resumeTicketsPurged + right.resumeTicketsPurged).toBe(2);
      expect(left.commandsPurged + right.commandsPurged).toBe(2);
      expect(left.outboxEventsPurged + right.outboxEventsPurged).toBe(6);
      expect(await counts(first)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
      expect(await counts(second)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
    });

    it('cède sans attendre devant l’advisory d’un writer et libère immédiatement le lock bootstrap', async () => {
      const fixture = await setup.$transaction((tx) => insertFixture(
        tx,
        'writer-advisory',
        { withChildren: true },
      ));
      const writerEntered = deferred<void>();
      const releaseWriter = deferred<void>();
      const writer = runtime.withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${fixture.companyId}:${fixture.sessionHandle}`}, 0)
          )
        `;
        writerEntered.resolve(undefined);
        await releaseWriter.promise;
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
            FROM realtime_mistral_conversation_missions
           WHERE id = ${fixture.missionId}::uuid
             AND "companyId" = ${fixture.companyId}
           FOR UPDATE
        `;
        expect(locked).toEqual([{ id: fixture.missionId }]);
      });
      await writerEntered.promise;

      try {
        const startedAt = Date.now();
        const skipped = await reaper2.purgeBatch(100);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        expect(skipped.lockSkipped).toBeGreaterThanOrEqual(1);
        expect(skipped.missionsPurged).toBe(0);
        expect(skipped.bootstrapsPurged).toBe(0);
        expect(await counts(fixture)).toEqual({
          bootstraps: 1,
          missions: 1,
          receipts: 1,
          resumes: 1,
          commands: 1,
          outbox: 3,
          leases: 0,
        });

        await expect(setup.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
          return tx.$queryRaw`
            SELECT id
              FROM realtime_mistral_conversation_bootstrap_tickets
             WHERE id = ${fixture.bootstrapId}::uuid
             FOR UPDATE NOWAIT
          `;
        })).resolves.toHaveLength(1);
      } finally {
        releaseWriter.resolve(undefined);
      }
      await writer;

      const purged = await reaper2.purgeBatch(100);
      expect(purged).toMatchObject({
        missionsPurged: 1,
        bootstrapsPurged: 1,
        resumeTicketsPurged: 1,
        commandsPurged: 1,
        outboxEventsPurged: 3,
      });
      expect(await counts(fixture)).toEqual({
        bootstraps: 0,
        missions: 0,
        receipts: 1,
        resumes: 0,
        commands: 0,
        outbox: 0,
        leases: 0,
      });
    });
  },
);
