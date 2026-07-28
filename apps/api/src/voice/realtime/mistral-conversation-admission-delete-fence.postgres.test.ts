import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type {
  MistralConversationBootstrapGrant,
  MistralConversationDurableCommand,
  MistralConversationDurableSnapshot,
} from './mistral-conversation-gateway-v2';
import type { MistralConversationCompletionTransactionPort } from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import type { RealtimeAdmissionPolicy, RealtimeAdmissionLease } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_LEASE_FENCE_CERT
  === 'true';
const CONTEXT_DIGEST = 'a'.repeat(64);

const admissionPolicy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 10,
  userLimitPerHour: 100,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 30,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

const completion: MistralConversationCompletionTransactionPort = {
  authorizeAndOpen: () => Promise.resolve({ status: 'opened' }),
};

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral v2 — fence PostgreSQL du DELETE admission',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mcv2-lease-fence-${suffix}`;
    const otherCompanyId = `mcv2-lease-fence-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let admission: PrismaRealtimeAdmission;
    let durable: PrismaMistralConversationDurableAuthority;

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral v2 lease fence certification ${discriminator}`,
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

    async function reserve(subjectHash: string): Promise<RealtimeAdmissionLease> {
      const result = await admission.reserve({
        companyId,
        subjectHash,
        sessionId: randomUUID(),
        maxSessionSeconds: 900,
        subjectHashCandidates: [subjectHash],
        principalBindingHash: subjectHash,
        agentMissionBinding: null,
      });
      if (!result.allowed) throw new Error(`Unexpected admission denial: ${result.denial}`);
      return result.lease;
    }

    async function seedBootstrapEvidence(
      grant: MistralConversationBootstrapGrant,
    ): Promise<void> {
      const [lease] = await admin.$queryRaw<Array<{
        leaseTokenHash: string;
        leaseExpiresAt: Date;
        hardExpiresAt: Date;
        state: string;
        providerId: string | null;
        providerCallId: string | null;
      }>>`
        SELECT btrim("leaseTokenHash") AS "leaseTokenHash", "leaseExpiresAt", "hardExpiresAt",
               state, "providerId", "providerCallId"
          FROM realtime_session_leases
         WHERE "companyId" = ${grant.companyId}
           AND "subjectHash" = ${grant.subjectHash}
           AND "sessionId" = ${grant.admissionSessionId}::uuid
      `;
      if (
        !lease
        || lease.state !== 'active'
        || lease.providerId !== 'mistral'
        || lease.providerCallId !== `mcv2:${grant.bootstrapId}`
        || lease.hardExpiresAt.toISOString() !== grant.hardExpiresAt
      ) throw new Error('Mistral lease-fence certification lease diverged.');
      const [identityRange] = await admin.$queryRaw<Array<{ minimumVersion: number }>>`
        SELECT "minimumVersion"
          FROM realtime_mistral_conversation_identity_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-bootstrap-identity-v1'
      `;
      if (!identityRange || identityRange.minimumVersion < 1) {
        throw new Error('Mistral identity key range missing for lease-fence certification.');
      }
      const issuedAt = new Date(Date.now() - 1_000);
      const ticketExpiresAt = new Date(Math.min(
        Date.now() + 20_000,
        lease.leaseExpiresAt.getTime(),
      ));
      const retentionExpiresAt = new Date(lease.hardExpiresAt.getTime() + 24 * 60 * 60_000);
      const ticketHash = createHash('sha256')
        .update(`lease-fence-ticket:${suffix}:${grant.bootstrapId}`, 'utf8')
        .digest('hex');

      await workers[0].withTenant(grant.companyId, async (tx) => {
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
            ${grant.bootstrapId}::uuid, ${grant.companyId}, ${grant.admissionSessionId}::uuid,
            ${grant.sessionHandle}, ${grant.subjectHash}, ${grant.subjectKeyVersion},
            ${lease.leaseTokenHash}, ${ticketHash}, 'bob.mistral-pcm.v2', 'issued', ${grant.plan},
            1, ${grant.contextRevision},
            ${JSON.stringify({ version: 1, revision: grant.contextRevision, context: {} })}::jsonb,
            ${grant.contextDigest}, decode('aa', 'hex'), decode(repeat('11', 12), 'hex'),
            decode(repeat('22', 16), 'hex'), ${identityRange.minimumVersion}, ${grant.routeMode},
            ${grant.fullDuplexCertified}, ${grant.maxMissionAudioBytes}, ${issuedAt},
            ${ticketExpiresAt}, ${lease.leaseExpiresAt}, ${lease.hardExpiresAt}, NULL,
            ${retentionExpiresAt}, 1, ${issuedAt}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      });
    }

    async function consumeBootstrapEvidence(
      grant: MistralConversationBootstrapGrant,
    ): Promise<void> {
      const updated = await workers[0].withTenant(grant.companyId, (tx) => tx.$executeRaw`
        UPDATE realtime_mistral_conversation_bootstrap_tickets
           SET state = 'consumed', "consumedAt" = clock_timestamp(), version = 2,
               "updatedAt" = clock_timestamp()
         WHERE id = ${grant.bootstrapId}::uuid
           AND "companyId" = ${grant.companyId}
           AND state = 'issued'
      `);
      if (updated !== 1) throw new Error('Mistral lease-fence bootstrap was not consumed exactly.');
    }

    async function apply(
      grant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
      snapshot: MistralConversationDurableSnapshot,
      command: MistralConversationDurableCommand,
    ): Promise<MistralConversationDurableSnapshot> {
      const result = await durable.transition({
        companyId: grant.companyId,
        subjectHash: grant.subjectHash,
        sessionHandle: grant.sessionHandle,
        ownerLeaseToken,
        missionConnectionEpoch: snapshot.missionConnectionEpoch,
        expectedVersion: snapshot.version,
        maxUnacknowledgedEvents: 253,
        maxUnacknowledgedBytes: 192 * 1024,
        command,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe('applied');
      if (result.status !== 'applied') {
        throw new Error(`Expected applied transition, received ${result.status}.`);
      }
      return result.snapshot;
    }

    async function assertTransientLeaseDeleteRejected(input: {
      providerCallId: string;
      subjectHash: string;
      expectedMessage: RegExp;
    }): Promise<void> {
      const sessionId = randomUUID();
      const leaseTokenHash = randomUUID().replaceAll('-', '').repeat(2);
      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "providerId", "providerCallId", "reservedAt", "leaseExpiresAt",
            "hardExpiresAt", "activatedAt", "updatedAt"
          ) VALUES (
            ${companyId}, ${input.subjectHash}, ${sessionId}::uuid, ${leaseTokenHash}, 'active',
            'mistral', ${input.providerCallId}, clock_timestamp(),
            clock_timestamp() + interval '30 seconds',
            clock_timestamp() + interval '60 seconds', clock_timestamp(), clock_timestamp()
          )
        `;
        await tx.$executeRaw`
          DELETE FROM realtime_session_leases
           WHERE "companyId" = ${companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${sessionId}::uuid
        `;
      })).rejects.toThrow(input.expectedMessage);
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workers = [
        new PrismaService({ datasourceUrl: runtimeUrl }),
        new PrismaService({ datasourceUrl: runtimeUrl }),
      ];
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);

      const [floor] = await admin.$queryRaw<Array<{ highestVersion: number }>>`
        SELECT "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-persistence-v1'
      `;
      if (!floor || !Number.isInteger(floor.highestVersion) || floor.highestVersion < 1) {
        throw new Error('Le registre de clé Mistral doit être staged avant cette certification.');
      }
      const keys: MistralConversationPersistenceKeyRing = {
        currentVersion: floor.highestVersion,
        secret: (version) => version === floor.highestVersion
          ? new Uint8Array(32).fill((floor.highestVersion % 255) || 1)
          : null,
      };

      admission = new PrismaRealtimeAdmission(workers[0], admissionPolicy);
      durable = new PrismaMistralConversationDurableAuthority(workers[0], completion, keys);
      await admin.company.createMany({ data: [company(companyId, 1), company(otherCompanyId, 2)] });
    }, 30_000);

    afterAll(async () => {
      // Base de certification jetable : la Mission et son outbox restent volontairement jusqu'à
      // leur rétention. Le test ne désactive jamais les triggers pour se nettoyer.
      await Promise.allSettled([
        ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('refuse le live et les identités inexactes, puis libère seulement la Mission close exacte', async () => {
      const subjectHash = 'b'.repeat(64);
      const lease = await reserve(subjectHash);
      const bootstrapId = randomUUID();
      const providerCallId = `mcv2:${bootstrapId}`;
      expect(await admission.bindProvider({
        ...lease,
        providerId: 'mistral',
        providerCallId,
      })).toEqual(expect.objectContaining({ ok: true }));
      expect(await admission.activate(lease)).toEqual(expect.objectContaining({ ok: true }));

      const grant: MistralConversationBootstrapGrant = {
        bootstrapId,
        admissionSessionId: lease.sessionId,
        companyId,
        subjectHash,
        subjectKeyVersion: 1,
        plan: 'pro',
        sessionHandle: lease.sessionId,
        hardExpiresAt: lease.hardExpiresAt,
        contextRevision: 1,
        contextDigest: CONTEXT_DIGEST,
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 320_000,
      };
      await seedBootstrapEvidence(grant);
      const ownerLeaseToken = `owner_${randomUUID().replaceAll('-', '')}`;
      const opened = await durable.open({
        grant,
        ownerLeaseToken,
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      });
      expect(opened.status).toBe('opened');
      if (opened.status !== 'opened') throw new Error(`Expected opened, received ${opened.status}.`);
      await consumeBootstrapEvidence(grant);

      const [runtimeIdentity] = await workers[0].withTenant(companyId, (tx) => tx.$queryRaw<Array<{
        currentUser: string;
        isSuperuser: boolean;
        bypassRls: boolean;
      }>>`
        SELECT current_user AS "currentUser", role.rolsuper AS "isSuperuser",
               role.rolbypassrls AS "bypassRls"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `);
      expect(runtimeIdentity).toEqual({
        currentUser: 'bob_app',
        isSuperuser: false,
        bypassRls: false,
      });

      await expect(workers[0].withTenant(companyId, (tx) => tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${subjectHash}
           AND "sessionId" = ${lease.sessionId}::uuid
      `)).rejects.toThrow(/requires an exact closed Mission/u);

      expect(await workers[1].withTenant(otherCompanyId, (tx) => tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${subjectHash}
           AND "sessionId" = ${lease.sessionId}::uuid
      `)).toBe(0);

      let snapshot = await apply(grant, ownerLeaseToken, opened.snapshot, {
        type: 'drain',
        commandId: 'drain:lease-delete-fence-certification',
        reason: 'user',
        cancellationId: randomUUID(),
      });
      snapshot = await apply(grant, ownerLeaseToken, snapshot, {
        type: 'close',
        commandId: 'close:lease-delete-fence-certification',
      });
      expect(snapshot.mission.phase).toBe('closed');

      const [terminal] = await admin.$queryRaw<Array<{
        phase: string;
        closedAt: Date | null;
        terminalServerSequence: bigint | null;
        terminalEvents: string[] | null;
      }>>`
        SELECT mission.phase, mission."closedAt", mission."terminalServerSequence",
               array_agg(event."eventType" ORDER BY event."serverSequence") FILTER (
                 WHERE event."serverSequence" BETWEEN mission."terminalServerSequence" - 1
                   AND mission."terminalServerSequence"
               ) AS "terminalEvents"
          FROM realtime_mistral_conversation_missions AS mission
          JOIN realtime_mistral_conversation_outbox AS event
            ON event."companyId" = mission."companyId"
           AND event."missionId" = mission.id
           AND event."sessionHandle" = mission."sessionHandle"
         WHERE mission."companyId" = ${companyId}
           AND mission."initialBootstrapId" = ${bootstrapId}::uuid
         GROUP BY mission.id
      `;
      expect(terminal).toMatchObject({
        phase: 'closed',
        closedAt: expect.any(Date),
        terminalEvents: ['session.draining', 'session.closed'],
      });

      expect(await workers[0].withTenant(companyId, (tx) => tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${subjectHash}
           AND "sessionId" = ${lease.sessionId}::uuid
      `)).toBe(1);

      await assertTransientLeaseDeleteRejected({
        providerCallId,
        subjectHash: 'c'.repeat(64),
        expectedMessage: /requires an exact closed Mission/u,
      });
      await assertTransientLeaseDeleteRejected({
        providerCallId: 'mcv2:not-a-uuid',
        subjectHash: 'd'.repeat(64),
        expectedMessage: /malformed mistral conversation admission provider identity/u,
      });

      const [remaining] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
      `;
      expect(remaining?.count).toBe(0);
    }, 30_000);
  },
);
