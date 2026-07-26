import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionLease, RealtimeAdmissionPolicy, RealtimeReapingClaim } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import { PrismaMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket.prisma';
import { DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY } from './mistral-conversation-bootstrap-ticket';
import type { MistralConversationDurableSnapshot } from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import type { MistralRealtimeIngressIdentityKeyRing } from './realtime-mistral-ingress-ticket';
import type {
  RealtimeProviderTerminationCause,
  RealtimeProviderTerminationRequest,
} from './realtime-provider-registry';

const RUN_POSTGRES_CERT = process.env
  .RUN_POSTGRES_MISTRAL_CONVERSATION_REAPER_TERMINATION_CERT === 'true';
const CONTEXT = {
  screen: { name: '/devis/new', instanceId: 'reaper-termination-postgres' },
  entities: [],
  capabilities: ['screen.read' as const],
};
const identityKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1
    ? 'reaper-termination-identity-certification-secret-v1'.repeat(2)
    : null,
};

const admissionPolicy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 20,
  userLimitPerHour: 100,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 5,
  activeLeaseSeconds: 10,
  heartbeatSeconds: 2,
  reaperLeaseSeconds: 30,
};

class CertificationCompletionPort implements MistralConversationCompletionTransactionPort {
  async authorizeAndOpen(
    _tx: Prisma.TransactionClient,
    _input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    return { status: 'opened' };
  }
}

interface MissionEvidence {
  readonly version: bigint;
  readonly nextServerSequence: bigint;
  readonly phase: string;
  readonly terminalReason: string | null;
  readonly terminalServerSequence: bigint | null;
  readonly closedAt: Date | null;
  readonly receiptCount: number;
  readonly receiptMatches: boolean;
  readonly outboxCount: number;
  readonly terminalEvents: string[] | null;
}

interface LeaseEvidence {
  readonly state: string;
  readonly providerId: string | null;
  readonly providerCallId: string | null;
  readonly reaperTokenHash: string | null;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly version: number;
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral v2 — terminaison reaper PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mcv2-reaper-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const completion = new CertificationCompletionPort();
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let admissions: [PrismaRealtimeAdmission, PrismaRealtimeAdmission];
    let durable: PrismaMistralConversationDurableAuthority;
    let bootstrap: PrismaMistralConversationBootstrapTicketAuthority;

    function company() {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id: companyId,
        name: 'Mistral v2 reaper termination certification',
        legalForm: 'EI' as const,
        siren,
        siret: `${siren}00001`,
        trade: 'certification',
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      };
    }

    async function createMission(
      label: string,
      maxSessionSeconds = 60,
    ): Promise<{
      readonly lease: RealtimeAdmissionLease;
      readonly bootstrapId: string;
      readonly providerCallId: string;
      readonly ownerLeaseToken: string;
      readonly snapshot: MistralConversationDurableSnapshot;
    }> {
      const subjectHash = createHash('sha256')
        .update(`mcv2-reaper:${suffix}:${label}`, 'utf8')
        .digest('hex');
      const reserved = await admissions[0].reserve({
        companyId,
        subjectHash,
        sessionId: randomUUID(),
        maxSessionSeconds,
        subjectHashCandidates: [subjectHash],
        principalBindingHash: subjectHash,
        agentMissionBinding: null,
      });
      if (!reserved.allowed) {
        throw new Error(`Unexpected admission denial: ${reserved.denial}`);
      }
      const lease = reserved.lease;
      const issued = await bootstrap.issue({
        lease,
        userId: `certification-user:${label}`,
        subjectKeyVersion: 1,
        plan: 'pro',
        contextSchemaVersion: 1,
        contextRevision: 1,
        context: CONTEXT,
      });
      expect(issued.status).toBe('issued');
      if (issued.status !== 'issued') {
        throw new Error(`Expected issued bootstrap, received ${issued.status}.`);
      }
      const ownerLeaseToken = `owner_${randomUUID().replaceAll('-', '')}`;
      const opened = await bootstrap.redeemAndOpenInitial({
        companyId,
        ticket: issued.bootstrap.ticket,
        protocol: issued.bootstrap.protocol,
        ownerLeaseToken,
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      });
      expect(opened.status).toBe('opened');
      if (opened.status !== 'opened') {
        throw new Error(`Expected opened Mission, received ${opened.status}.`);
      }
      const [provider] = await admin.$queryRaw<Array<{
        providerCallId: string | null;
        bootstrapId: string;
      }>>`
        SELECT lease."providerCallId", mission."initialBootstrapId"::text AS "bootstrapId"
          FROM realtime_session_leases AS lease
          JOIN realtime_mistral_conversation_missions AS mission
            ON mission."companyId" = lease."companyId"
           AND mission."subjectHash" = lease."subjectHash"
           AND mission."admissionSessionId" = lease."sessionId"
         WHERE lease."companyId" = ${companyId}
           AND lease."subjectHash" = ${lease.subjectHash}
           AND lease."sessionId" = ${lease.sessionId}::uuid
      `;
      if (!provider?.providerCallId) throw new Error('Bound mcv2 provider identity missing.');
      expect(provider.providerCallId).toBe(`mcv2:${provider.bootstrapId}`);
      return {
        lease,
        bootstrapId: provider.bootstrapId,
        providerCallId: provider.providerCallId,
        ownerLeaseToken,
        snapshot: opened.snapshot,
      };
    }

    async function evidence(sessionId: string): Promise<MissionEvidence> {
      const [row] = await admin.$queryRaw<MissionEvidence[]>`
        SELECT mission.version, mission."nextServerSequence", mission.phase,
               mission."terminalReason", mission."terminalServerSequence", mission."closedAt",
               (
                 SELECT count(*)::int
                   FROM realtime_mistral_conversation_terminal_receipts AS receipt
                  WHERE receipt."companyId" = mission."companyId"
                    AND receipt."sessionHandle" = mission."sessionHandle"
               ) AS "receiptCount",
               EXISTS (
                 SELECT 1
                   FROM realtime_mistral_conversation_terminal_receipts AS receipt
                  WHERE mission.phase = 'closed'
                    AND receipt."companyId" = mission."companyId"
                    AND receipt."sessionHandle" = mission."sessionHandle"
                    AND receipt."subjectHash" IS NOT DISTINCT FROM mission."subjectHash"
                    AND receipt."subjectKeyVersion" IS NOT DISTINCT FROM
                        mission."subjectKeyVersion"
                    AND receipt.protocol IS NOT DISTINCT FROM mission.protocol
                    AND receipt."missionConnectionEpoch" IS NOT DISTINCT FROM
                        mission."missionConnectionEpoch"
                    AND receipt."nextServerSequence" IS NOT DISTINCT FROM
                        mission."nextServerSequence"
                    AND receipt."terminalReason" IS NOT DISTINCT FROM mission."terminalReason"
                    AND receipt."closedAt" IS NOT DISTINCT FROM mission."closedAt"
               ) AS "receiptMatches",
               (
                 SELECT count(*)::int
                   FROM realtime_mistral_conversation_outbox AS event
                  WHERE event."companyId" = mission."companyId"
                    AND event."missionId" = mission.id
               ) AS "outboxCount",
               CASE
                 WHEN mission."terminalServerSequence" IS NULL THEN NULL
                 ELSE (
                   SELECT array_agg(event."eventType" ORDER BY event."serverSequence")
                     FROM realtime_mistral_conversation_outbox AS event
                    WHERE event."companyId" = mission."companyId"
                      AND event."missionId" = mission.id
                      AND event."serverSequence" BETWEEN
                        mission."terminalServerSequence" - 1
                        AND mission."terminalServerSequence"
                 )
               END AS "terminalEvents"
          FROM realtime_mistral_conversation_missions AS mission
         WHERE mission."companyId" = ${companyId}
           AND mission."sessionHandle" = ${sessionId}
      `;
      if (!row) throw new Error('Durable Mission evidence missing.');
      return row;
    }

    async function leaseEvidence(lease: RealtimeAdmissionLease): Promise<LeaseEvidence> {
      const [row] = await admin.$queryRaw<LeaseEvidence[]>`
        SELECT state, "providerId", "providerCallId", "reaperTokenHash", "leaseExpiresAt",
               "hardExpiresAt", version
          FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${lease.subjectHash}
           AND "sessionId" = ${lease.sessionId}::uuid
      `;
      if (!row) throw new Error('Reaping lease evidence missing.');
      return row;
    }

    async function expireLeaseHeartbeat(lease: RealtimeAdmissionLease): Promise<void> {
      await admin.$executeRaw`
        UPDATE realtime_session_leases
           SET "leaseExpiresAt" = clock_timestamp() - interval '1 millisecond',
               "updatedAt" = clock_timestamp()
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${lease.subjectHash}
           AND "sessionId" = ${lease.sessionId}::uuid
      `;
    }

    async function claimExpired(lease: RealtimeAdmissionLease): Promise<RealtimeReapingClaim> {
      const batch = await admissions[1].claimExpired({ companyId, limit: 20 });
      expect(batch.ok).toBe(true);
      if (!batch.ok) throw new Error('Reaping batch unavailable.');
      const claim = batch.claims.find((candidate) => candidate.sessionId === lease.sessionId);
      if (!claim) throw new Error('Expected reaping claim was not returned.');
      return claim;
    }

    async function claimExplicit(lease: RealtimeAdmissionLease): Promise<RealtimeReapingClaim> {
      const claimed = await admissions[1].claimTermination({
        companyId,
        subjectHashCandidates: [lease.subjectHash],
        principalBindingHash: lease.subjectHash,
        sessionId: lease.sessionId,
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok || !claimed.claim) throw new Error('Explicit reaping claim missing.');
      return claimed.claim;
    }

    async function waitForDatabaseTime(target: string): Promise<void> {
      const targetEpoch = Date.parse(target);
      if (!Number.isFinite(targetEpoch)) throw new Error('Invalid database time target.');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [clock] = await admin.$queryRaw<Array<{ databaseNow: Date }>>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (clock && clock.databaseNow.getTime() >= targetEpoch) return;
        const remaining = Math.max(1, targetEpoch - (clock?.databaseNow.getTime() ?? Date.now()));
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
      }
      throw new Error('PostgreSQL clock did not reach the hard expiry boundary.');
    }

    function terminationRequest(
      claim: RealtimeReapingClaim,
      terminationCause: RealtimeProviderTerminationCause,
    ): RealtimeProviderTerminationRequest {
      return { ...claim, terminationCause };
    }

    async function assertTerminalized(input: {
      readonly lease: RealtimeAdmissionLease;
      readonly claim: RealtimeReapingClaim;
      readonly cause: RealtimeProviderTerminationCause;
      readonly expectedOwnerTransitionStatus: 'not_owner' | 'expired';
      readonly expectedReason: 'user' | 'expired' | 'fatal_error';
      readonly ownerLeaseToken: string;
      readonly snapshot: MistralConversationDurableSnapshot;
    }): Promise<void> {
      const before = await evidence(input.lease.sessionId);
      const beforeLease = await leaseEvidence(input.lease);
      const request = terminationRequest(input.claim, input.cause);
      const forgedReaperToken = `${request.reaperToken.startsWith('A') ? 'B' : 'A'}${
        request.reaperToken.slice(1)
      }`;

      expect(before).toMatchObject({ receiptCount: 0, receiptMatches: false });

      expect(await durable.transition({
        companyId,
        subjectHash: input.lease.subjectHash,
        sessionHandle: input.lease.sessionId,
        ownerLeaseToken: input.ownerLeaseToken,
        missionConnectionEpoch: input.snapshot.missionConnectionEpoch,
        expectedVersion: input.snapshot.version,
        maxUnacknowledgedEvents: 253,
        maxUnacknowledgedBytes: 192 * 1024,
        command: {
          type: 'record_error',
          commandId: `error:stale-owner:${input.lease.sessionId}`,
          errorCode: 'internal_error',
          retryable: true,
        },
        signal: new AbortController().signal,
      })).toEqual({ status: input.expectedOwnerTransitionStatus });
      expect(await evidence(input.lease.sessionId)).toEqual(before);
      expect(await leaseEvidence(input.lease)).toEqual(beforeLease);

      expect(await durable.terminateReaping({
        ...request,
        reaperToken: forgedReaperToken,
      })).toEqual({ status: 'stale_fence' });
      expect(await evidence(input.lease.sessionId)).toEqual(before);
      expect(await leaseEvidence(input.lease)).toEqual(beforeLease);

      expect(await durable.terminateReaping({
        ...request,
        subjectHash: 'f'.repeat(64),
      })).toEqual({ status: 'invalid' });
      expect(await evidence(input.lease.sessionId)).toEqual(before);
      expect(await leaseEvidence(input.lease)).toEqual(beforeLease);

      expect(await durable.terminateReaping(request)).toEqual({ status: 'terminated' });
      const terminal = await evidence(input.lease.sessionId);
      expect(terminal).toMatchObject({
        phase: 'closed',
        terminalReason: input.expectedReason,
        closedAt: expect.any(Date),
        terminalEvents: ['session.draining', 'session.closed'],
        outboxCount: before.outboxCount + 2,
        receiptCount: 1,
        receiptMatches: true,
      });
      expect(terminal.version).toBe(before.version + 2n);
      expect(terminal.nextServerSequence).toBe(before.nextServerSequence + 2n);
      expect(terminal.terminalServerSequence).toBe(terminal.nextServerSequence - 1n);

      expect(await durable.terminateReaping(request)).toEqual({ status: 'replayed' });
      expect(await evidence(input.lease.sessionId)).toEqual(terminal);

      expect(await admissions[0].completeReaping({
        companyId,
        subjectHash: input.lease.subjectHash,
        sessionId: input.lease.sessionId,
        reaperToken: input.claim.reaperToken,
      })).toEqual({ ok: true, reason: null });
      const [leaseCount] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_session_leases
         WHERE "companyId" = ${companyId}
           AND "subjectHash" = ${input.lease.subjectHash}
           AND "sessionId" = ${input.lease.sessionId}::uuid
      `;
      expect(leaseCount?.count).toBe(0);
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
      admissions = workers.map(
        (worker) => new PrismaRealtimeAdmission(worker, admissionPolicy),
      ) as typeof admissions;
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);

      const [floor] = await admin.$queryRaw<Array<{ highestVersion: number }>>`
        SELECT "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-persistence-v1'
      `;
      if (!floor || !Number.isInteger(floor.highestVersion) || floor.highestVersion < 1) {
        throw new Error('Le registre de clé Mistral doit être staged avant cette certification.');
      }
      const persistenceKeys: MistralConversationPersistenceKeyRing = {
        currentVersion: floor.highestVersion,
        secret: (version) => version === floor.highestVersion
          ? new Uint8Array(32).fill((floor.highestVersion % 255) || 1)
          : null,
      };
      durable = new PrismaMistralConversationDurableAuthority(
        workers[0],
        completion,
        persistenceKeys,
      );
      bootstrap = new PrismaMistralConversationBootstrapTicketAuthority(
        workers[0],
        durable,
        identityKeys,
        DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
      );
      await admin.company.create({ data: company() });
    }, 30_000);

    afterAll(async () => {
      // Base de certification jetable : les Missions/outbox restent append-only jusqu'à leur
      // rétention. Aucun trigger, rôle RLS ou session_replication_role n'est neutralisé ici.
      await Promise.allSettled([
        ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('fence les faux claims puis ferme atomiquement une expiration de heartbeat', async () => {
      const [runtimeRole] = await workers[0].$queryRaw<Array<{
        currentUser: string;
        isSuperuser: boolean;
        bypassRls: boolean;
      }>>`
        SELECT current_user AS "currentUser", role.rolsuper AS "isSuperuser",
               role.rolbypassrls AS "bypassRls"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(runtimeRole).toEqual({
        currentUser: 'bob_app',
        isSuperuser: false,
        bypassRls: false,
      });

      const mission = await createMission('heartbeat-expired');
      await expireLeaseHeartbeat(mission.lease);
      const claim = await claimExpired(mission.lease);
      expect(claim.hardExpiryProof).toBeNull();
      await assertTerminalized({
        lease: mission.lease,
        claim,
        cause: 'lease_expired',
        expectedOwnerTransitionStatus: 'not_owner',
        expectedReason: 'fatal_error',
        ownerLeaseToken: mission.ownerLeaseToken,
        snapshot: mission.snapshot,
      });
    }, 30_000);

    it('traduit un hangup explicite en raison user avant de franchir la borne dure', async () => {
      const mission = await createMission('explicit-hangup');
      const claim = await claimExplicit(mission.lease);
      expect(claim.hardExpiryProof).toBeNull();
      await assertTerminalized({
        lease: mission.lease,
        claim,
        cause: 'explicit_hangup',
        expectedOwnerTransitionStatus: 'not_owner',
        expectedReason: 'user',
        ownerLeaseToken: mission.ownerLeaseToken,
        snapshot: mission.snapshot,
      });
    }, 30_000);

    it('lie la preuve PostgreSQL de hard expiry et persiste la raison expired', async () => {
      const mission = await createMission('hard-expired', 1);
      await waitForDatabaseTime(mission.lease.hardExpiresAt);
      const claim = await claimExpired(mission.lease);
      expect(claim.hardExpiryProof).toMatchObject({
        source: 'database_hard_expiry',
        companyId,
        subjectHash: mission.lease.subjectHash,
        sessionId: mission.lease.sessionId,
        providerId: 'mistral',
        providerCallId: mission.providerCallId,
        hardExpiresAt: mission.lease.hardExpiresAt,
      });
      await assertTerminalized({
        lease: mission.lease,
        claim,
        cause: 'lease_expired',
        expectedOwnerTransitionStatus: 'expired',
        expectedReason: 'expired',
        ownerLeaseToken: mission.ownerLeaseToken,
        snapshot: mission.snapshot,
      });
    }, 30_000);
  },
);
