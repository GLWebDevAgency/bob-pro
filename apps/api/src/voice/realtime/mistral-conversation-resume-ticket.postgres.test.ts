import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  MISTRAL_CONVERSATION_PROTOCOL,
  reduceMistralConversationMissionState,
} from '@bob/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type {
  MistralConversationBootstrapGrant,
  MistralConversationDurableCommand,
  MistralConversationDurableOpenResult,
  MistralConversationDurableSnapshot,
  MistralConversationDurableTransitionResult,
} from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import { PrismaMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
  type MistralConversationRedeemAndOpenResult,
  type MistralConversationResumeTicketIssueResult,
} from './mistral-conversation-resume-ticket';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_CERT === 'true';
const CONTEXT_DIGEST = 'a'.repeat(64);
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 240 * 1024;
const MAX_UNACKNOWLEDGED_EVENTS = 253;
const MAX_UNACKNOWLEDGED_BYTES = 192 * 1024;

const keys: MistralConversationPersistenceKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1 ? new Uint8Array(32).fill(1) : null,
};

class CertificationCompletionPort implements MistralConversationCompletionTransactionPort {
  async authorizeAndOpen(
    _tx: Prisma.TransactionClient,
    _input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    return { status: 'opened' };
  }
}

function opened(
  result: MistralConversationDurableOpenResult,
): asserts result is Extract<MistralConversationDurableOpenResult, { readonly status: 'opened' }> {
  expect(result.status).toBe('opened');
  if (result.status !== 'opened') throw new Error(`Expected opened, received ${result.status}.`);
}

function applied(
  result: MistralConversationDurableTransitionResult,
): asserts result is Extract<
  MistralConversationDurableTransitionResult,
  { readonly status: 'applied' | 'replayed' }
> & { readonly status: 'applied' } {
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error(`Expected applied, received ${result.status}.`);
}

function issued(
  result: MistralConversationResumeTicketIssueResult,
): asserts result is Extract<MistralConversationResumeTicketIssueResult, { readonly status: 'issued' }> {
  expect(result.status).toBe('issued');
  if (result.status !== 'issued') throw new Error(`Expected issued, received ${result.status}.`);
}

function terminalReplay(
  result: MistralConversationRedeemAndOpenResult,
): asserts result is Extract<MistralConversationRedeemAndOpenResult, {
  readonly status: 'terminal_replay';
}> {
  expect(result.status).toBe('terminal_replay');
  if (result.status !== 'terminal_replay') {
    throw new Error(`Expected terminal_replay, received ${result.status}.`);
  }
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral conversation v2 resume — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `resume-v2-${suffix}`;
    const otherCompanyId = `resume-v2-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const completion = new CertificationCompletionPort();
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let durableAuthorities: [
      PrismaMistralConversationDurableAuthority,
      PrismaMistralConversationDurableAuthority,
    ];
    let resumeAuthorities: [
      PrismaMistralConversationResumeAuthority,
      PrismaMistralConversationResumeAuthority,
    ];

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral resume PostgreSQL certification ${discriminator}`,
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
        .update(`mistral-resume-cert:${suffix}:${label}`, 'utf8')
        .digest('hex');
    }

    function grant(
      label: string,
      options: { readonly hardExpiresAt?: string; readonly subjectHash?: string } = {},
    ): MistralConversationBootstrapGrant {
      const admissionSessionId = randomUUID().toLowerCase();
      return {
        bootstrapId: randomUUID(),
        admissionSessionId,
        companyId,
        subjectHash: options.subjectHash ?? digest(`subject:${label}`),
        subjectKeyVersion: 1,
        plan: 'pro',
        sessionHandle: admissionSessionId,
        hardExpiresAt: options.hardExpiresAt
          ?? new Date(Date.now() + 15 * 60_000).toISOString(),
        contextRevision: 1,
        contextDigest: CONTEXT_DIGEST,
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
      ) throw new Error('Invalid exact Mistral resume certification grant.');
      const issuedAt = new Date(now - 1_000);
      const ticketExpiresAt = new Date(Math.min(now + 60_000, hardExpiresAt.getTime()));
      const retentionExpiresAt = new Date(hardExpiresAt.getTime() + 24 * 60 * 60_000);
      const leaseTokenHash = digest(`lease:${missionGrant.bootstrapId}`);
      const ticketHash = digest(`ticket:${missionGrant.bootstrapId}`);
      const providerCallId = `mcv2:${missionGrant.bootstrapId}`;
      const [identityRange] = await admin.$queryRaw<Array<{ minimumVersion: number }>>`
        SELECT "minimumVersion"
          FROM realtime_mistral_conversation_identity_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-bootstrap-identity-v1'
      `;
      if (!identityRange || identityRange.minimumVersion < 1) {
        throw new Error('Mistral identity key range missing for resume certification.');
      }

      await admin.$transaction(async (tx) => {
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
            ${missionGrant.contextRevision}, ${JSON.stringify({ screen: { name: '/certification' } })}::jsonb,
            ${missionGrant.contextDigest}, ${issuedAt}, ${issuedAt}, 3
          )
          ON CONFLICT ("companyId", "subjectHash") DO NOTHING
        `;
        const [lease] = await tx.$queryRaw<Array<{
          sessionId: string;
          leaseTokenHash: string;
          state: string;
          providerId: string | null;
          providerCallId: string | null;
          hardExpiresAt: Date;
        }>>`
          SELECT "sessionId"::text AS "sessionId", btrim("leaseTokenHash") AS "leaseTokenHash",
                 state, "providerId", "providerCallId", "hardExpiresAt"
            FROM realtime_session_leases
           WHERE "companyId" = ${missionGrant.companyId}
             AND "subjectHash" = ${missionGrant.subjectHash}
        `;
        if (
          !lease
          || lease.sessionId !== missionGrant.admissionSessionId
          || lease.leaseTokenHash !== leaseTokenHash
          || lease.state !== 'active'
          || lease.providerId !== 'mistral'
          || lease.providerCallId !== providerCallId
          || lease.hardExpiresAt.toISOString() !== missionGrant.hardExpiresAt
        ) throw new Error('Mistral resume certification lease diverged.');

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
            ${ticketHash}, ${MISTRAL_CONVERSATION_PROTOCOL}, 'issued', ${missionGrant.plan}, 1,
            ${missionGrant.contextRevision},
            ${JSON.stringify({ version: 1, revision: missionGrant.contextRevision, context: {} })}::jsonb,
            ${missionGrant.contextDigest}, decode('aa', 'hex'), decode(repeat('11', 12), 'hex'),
            decode(repeat('22', 16), 'hex'), ${identityRange.minimumVersion},
            ${missionGrant.routeMode}, ${missionGrant.fullDuplexCertified},
            ${missionGrant.maxMissionAudioBytes}, ${issuedAt}, ${ticketExpiresAt},
            ${hardExpiresAt}, ${hardExpiresAt}, NULL, ${retentionExpiresAt}, 1, ${issuedAt}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        const [bootstrap] = await tx.$queryRaw<Array<{
          companyId: string;
          admissionSessionId: string;
          sessionHandle: string;
          subjectHash: string;
          subjectKeyVersion: number;
          state: string;
          hardExpiresAt: Date;
        }>>`
          SELECT "companyId", "admissionSessionId"::text AS "admissionSessionId",
                 "sessionHandle", btrim("subjectHash") AS "subjectHash", "subjectKeyVersion",
                 state, "hardExpiresAt"
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE id = ${missionGrant.bootstrapId}::uuid
        `;
        if (
          !bootstrap
          || bootstrap.companyId !== missionGrant.companyId
          || bootstrap.admissionSessionId !== missionGrant.admissionSessionId
          || bootstrap.sessionHandle !== missionGrant.sessionHandle
          || bootstrap.subjectHash !== missionGrant.subjectHash
          || bootstrap.subjectKeyVersion !== missionGrant.subjectKeyVersion
          || !['issued', 'consumed'].includes(bootstrap.state)
          || bootstrap.hardExpiresAt.toISOString() !== missionGrant.hardExpiresAt
        ) throw new Error('Mistral resume certification bootstrap diverged.');
      });
    }

    async function consumeGrantEvidence(
      missionGrant: MistralConversationBootstrapGrant,
    ): Promise<void> {
      await admin.$transaction(async (tx) => {
        const [mission] = await tx.$queryRaw<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM realtime_mistral_conversation_missions
             WHERE "companyId" = ${missionGrant.companyId}
               AND "initialBootstrapId" = ${missionGrant.bootstrapId}::uuid
          ) AS "exists"
        `;
        if (!mission?.exists) return;
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_bootstrap_tickets
             SET state = 'consumed', "consumedAt" = clock_timestamp(), version = 2,
                 "updatedAt" = clock_timestamp()
           WHERE id = ${missionGrant.bootstrapId}::uuid
             AND "companyId" = ${missionGrant.companyId}
             AND state = 'issued'
        `;
        const [bootstrap] = await tx.$queryRaw<Array<{
          state: string;
          version: number;
          consumedAt: Date | null;
        }>>`
          SELECT state, version, "consumedAt"
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE id = ${missionGrant.bootstrapId}::uuid
             AND "companyId" = ${missionGrant.companyId}
        `;
        if (bootstrap?.state !== 'consumed' || bootstrap.version !== 2 || !bootstrap.consumedAt) {
          throw new Error('Mistral resume certification bootstrap was not consumed exactly.');
        }
      });
    }

    function owner(label: string): string {
      return `owner_${label}_${randomUUID().replaceAll('-', '')}`;
    }

    async function openMission(
      authority: PrismaMistralConversationDurableAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
    ): Promise<MistralConversationDurableOpenResult> {
      await seedGrantEvidence(missionGrant);
      const result = await authority.open({
        grant: missionGrant,
        ownerLeaseToken,
        resumeNextServerSequence: 0,
        maxReplayEvents: MAX_REPLAY_EVENTS,
        maxReplayBytes: MAX_REPLAY_BYTES,
        signal: new AbortController().signal,
      });
      await consumeGrantEvidence(missionGrant);
      return result;
    }

    async function transition(
      authority: PrismaMistralConversationDurableAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
      snapshot: MistralConversationDurableSnapshot,
      command: MistralConversationDurableCommand,
    ): Promise<MistralConversationDurableSnapshot> {
      const result = await authority.transition({
        companyId: missionGrant.companyId,
        subjectHash: missionGrant.subjectHash,
        sessionHandle: missionGrant.sessionHandle,
        ownerLeaseToken,
        missionConnectionEpoch: snapshot.missionConnectionEpoch,
        expectedVersion: snapshot.version,
        maxUnacknowledgedEvents: MAX_UNACKNOWLEDGED_EVENTS,
        maxUnacknowledgedBytes: MAX_UNACKNOWLEDGED_BYTES,
        command,
        signal: new AbortController().signal,
      });
      applied(result);
      return result.snapshot;
    }

    async function closeMission(
      label: string,
      authority = durableAuthorities[0],
    ): Promise<{
      readonly grant: MistralConversationBootstrapGrant;
      readonly ownerLeaseToken: string;
      readonly snapshot: MistralConversationDurableSnapshot;
    }> {
      const missionGrant = grant(label);
      const ownerLeaseToken = owner(label);
      const created = await openMission(authority, missionGrant, ownerLeaseToken);
      opened(created);
      const draining = await transition(
        authority,
        missionGrant,
        ownerLeaseToken,
        created.snapshot,
        {
          type: 'drain',
          commandId: `drain:${label}`,
          reason: 'user',
          cancellationId: randomUUID(),
        },
      );
      const closed = await transition(
        authority,
        missionGrant,
        ownerLeaseToken,
        draining,
        { type: 'close', commandId: `close:${label}` },
      );
      expect(closed.mission.phase).toBe('closed');
      return { grant: missionGrant, ownerLeaseToken, snapshot: closed };
    }

    async function issueTerminal(
      authority: PrismaMistralConversationResumeAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      snapshot: MistralConversationDurableSnapshot,
      resumeNextServerSequence = 0,
    ): Promise<Extract<MistralConversationResumeTicketIssueResult, {
      readonly status: 'issued';
    }>> {
      const result = await authority.issue({
        companyId: missionGrant.companyId,
        subjectHash: missionGrant.subjectHash,
        subjectKeyVersion: missionGrant.subjectKeyVersion,
        sessionHandle: missionGrant.sessionHandle,
        clientAcceptedMissionConnectionEpoch: snapshot.missionConnectionEpoch,
        resumeNextServerSequence,
        signal: new AbortController().signal,
      });
      issued(result);
      expect(result.bootstrap).toMatchObject({
        companyId: missionGrant.companyId,
        sessionHandle: missionGrant.sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'terminal_replay',
        expectedMissionConnectionEpoch: snapshot.missionConnectionEpoch,
        resumeNextServerSequence,
      });
      return result;
    }

    async function redeemTerminal(
      authority: PrismaMistralConversationResumeAuthority,
      issuedTicket: Extract<MistralConversationResumeTicketIssueResult, {
        readonly status: 'issued';
      }>,
    ): Promise<MistralConversationRedeemAndOpenResult> {
      return authority.redeemAndOpen({
        companyId: issuedTicket.bootstrap.companyId,
        ticket: issuedTicket.bootstrap.ticket,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        expectedScope: 'terminal_replay',
        resumeNextServerSequence: issuedTicket.bootstrap.resumeNextServerSequence,
        maxReplayEvents: MAX_REPLAY_EVENTS,
        maxReplayBytes: MAX_REPLAY_BYTES,
        signal: new AbortController().signal,
      });
    }

    interface MissionEvidence {
      readonly missionConnectionEpoch: number;
      readonly version: bigint;
      readonly acknowledgedServerSequence: bigint;
      readonly nextServerSequence: bigint;
      readonly phase: string;
      readonly terminalReason: string | null;
      readonly outboxCount: number;
    }

    async function missionEvidence(sessionHandle: string): Promise<MissionEvidence> {
      const [row] = await admin.$queryRaw<MissionEvidence[]>`
        SELECT mission."missionConnectionEpoch", mission.version,
               mission."acknowledgedServerSequence", mission."nextServerSequence",
               mission.phase, mission."terminalReason",
               (
                 SELECT count(*)::int
                   FROM realtime_mistral_conversation_outbox AS event
                  WHERE event."companyId" = mission."companyId"
                    AND event."missionId" = mission.id
               ) AS "outboxCount"
          FROM realtime_mistral_conversation_missions AS mission
         WHERE mission."companyId" = ${companyId}
           AND mission."sessionHandle" = ${sessionHandle}
      `;
      if (!row) throw new Error('Mistral resume mission evidence missing.');
      return row;
    }

    interface TicketEvidence {
      readonly state: string;
      readonly version: number;
      readonly scope: string;
      readonly consumedMissionConnectionEpoch: number | null;
      readonly replayConnectionId: string | null;
      readonly connectionLeaseTokenHash: string | null;
      readonly maxAcknowledgableServerSequence: bigint | null;
    }

    async function ticketEvidence(sessionHandle: string): Promise<TicketEvidence[]> {
      return admin.$queryRaw<TicketEvidence[]>`
        SELECT state, version, scope, "consumedMissionConnectionEpoch",
               "replayConnectionId", btrim("connectionLeaseTokenHash")
                 AS "connectionLeaseTokenHash",
               "maxAcknowledgableServerSequence"
          FROM realtime_mistral_conversation_resume_tickets
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${sessionHandle}
         ORDER BY "issuedAt", id
      `;
    }

    async function waitForDatabaseTime(target: string): Promise<void> {
      const targetEpoch = Date.parse(target);
      if (!Number.isFinite(targetEpoch)) throw new Error('Invalid certification timestamp.');
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const [clock] = await admin.$queryRaw<Array<{ databaseNow: Date }>>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (clock && clock.databaseNow.getTime() >= targetEpoch) return;
        const remaining = Math.max(1, targetEpoch - (clock?.databaseNow.getTime() ?? Date.now()));
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
      }
      throw new Error('PostgreSQL clock did not reach the requested certification boundary.');
    }

    function wrongToken(token: string): string {
      return `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
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
      durableAuthorities = [
        new PrismaMistralConversationDurableAuthority(workers[0], completion, keys),
        new PrismaMistralConversationDurableAuthority(workers[1], completion, keys),
      ];
      resumeAuthorities = [
        new PrismaMistralConversationResumeAuthority(workers[0], durableAuthorities[0]),
        new PrismaMistralConversationResumeAuthority(workers[1], durableAuthorities[1]),
      ];
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_resume_tickets
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_commands
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_outbox
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_missions
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_bootstrap_tickets
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_session_leases
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
          }).catch(() => undefined);
          await admin.company.deleteMany({
            where: { id: { in: [companyId, otherCompanyId] } },
          }).catch(() => undefined);
        }
      } finally {
        await Promise.allSettled([
          ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    });

    it('garde le live takeover désactivé par défaut et certifie FORCE RLS', async () => {
      const [privileges] = await workers[0].$queryRaw<Array<{
        canDelete: boolean;
      }>>`
        SELECT has_table_privilege(
          current_user,
          'realtime_mistral_conversation_resume_tickets',
          'DELETE'
        ) AS "canDelete"
      `;
      expect(privileges).toEqual({ canDelete: false });
      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          DELETE FROM realtime_mistral_conversation_resume_tickets
           WHERE "companyId" = ${companyId}
        `;
      })).rejects.toThrow();

      const [shape] = await admin.$queryRaw<Array<{
        rowSecurity: boolean;
        forceRowSecurity: boolean;
      }>>`
        SELECT relrowsecurity AS "rowSecurity", relforcerowsecurity AS "forceRowSecurity"
          FROM pg_class
         WHERE oid = 'realtime_mistral_conversation_resume_tickets'::regclass
      `;
      expect(shape).toEqual({ rowSecurity: true, forceRowSecurity: true });

      const missionGrant = grant('live_gate_default');
      const created = await openMission(
        durableAuthorities[0],
        missionGrant,
        owner('live_gate_default'),
      );
      opened(created);
      await expect(resumeAuthorities[0].issue({
        companyId,
        subjectHash: missionGrant.subjectHash,
        subjectKeyVersion: missionGrant.subjectKeyVersion,
        sessionHandle: missionGrant.sessionHandle,
        clientAcceptedMissionConnectionEpoch: created.snapshot.missionConnectionEpoch,
        resumeNextServerSequence: 0,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'unavailable' });
      expect(await ticketEvidence(missionGrant.sessionHandle)).toEqual([]);

      const recovering = reduceMistralConversationMissionState(created.snapshot.mission, {
        type: 'ROUTE_RECOVERY_STARTED',
        cancellation: null,
      });
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET phase = ${recovering.phase},
                 "missionState" = ${JSON.stringify(recovering)}::jsonb,
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
      });
      const liveEnabled = new PrismaMistralConversationResumeAuthority(
        workers[0],
        durableAuthorities[0],
        {
          policy: {
            ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
            liveTakeoverEnabled: true,
          },
        },
      );
      const beforeRecoveringIssue = await missionEvidence(missionGrant.sessionHandle);
      await expect(liveEnabled.issue({
        companyId,
        subjectHash: missionGrant.subjectHash,
        subjectKeyVersion: missionGrant.subjectKeyVersion,
        sessionHandle: missionGrant.sessionHandle,
        clientAcceptedMissionConnectionEpoch: created.snapshot.missionConnectionEpoch,
        resumeNextServerSequence: 0,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'unavailable' });
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(beforeRecoveringIssue);
      expect(await ticketEvidence(missionGrant.sessionHandle)).toEqual([]);
    });

    it('rejette en SQL la consommation live si le contexte dérive ou si la mission récupère', async () => {
      const liveEnabled = (workerIndex: 0 | 1) => new PrismaMistralConversationResumeAuthority(
        workers[workerIndex],
        durableAuthorities[workerIndex],
        {
          policy: {
            ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
            liveTakeoverEnabled: true,
          },
        },
      );
      const prepareLiveTicket = async (label: string, subjectHash: string) => {
        const missionGrant = grant(label, { subjectHash });
        const created = await openMission(
          durableAuthorities[0],
          missionGrant,
          owner(label),
        );
        opened(created);
        const result = await liveEnabled(0).issue({
          companyId,
          subjectHash,
          subjectKeyVersion: missionGrant.subjectKeyVersion,
          sessionHandle: missionGrant.sessionHandle,
          clientAcceptedMissionConnectionEpoch: created.snapshot.missionConnectionEpoch,
          resumeNextServerSequence: 0,
          signal: new AbortController().signal,
        });
        issued(result);
        expect(result.bootstrap.scope).toBe('live_takeover');
        return { missionGrant, created };
      };
      const consumeDirectly = async (sessionHandle: string, consumedEpoch: number) => (
        workers[1].withTenant(companyId, async (tx) => {
          await tx.$executeRaw`
            UPDATE realtime_mistral_conversation_resume_tickets
               SET state = 'consumed',
                   "consumedAt" = clock_timestamp(),
                   "consumedMissionConnectionEpoch" = ${consumedEpoch},
                   version = 2
             WHERE "companyId" = ${companyId}
               AND "sessionHandle" = ${sessionHandle}
               AND state = 'issued'
          `;
        })
      );

      const stale = await prepareLiveTicket('live_stale_context', 'e'.repeat(64));
      const staleMissionState = {
        ...stale.created.snapshot.mission,
        missionConnectionEpoch: stale.created.snapshot.missionConnectionEpoch + 1,
        contextRevision: stale.created.snapshot.mission.contextRevision + 1,
        contextDigest: 'b'.repeat(64),
      };
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET "missionConnectionEpoch" = "missionConnectionEpoch" + 1,
                 "contextRevision" = "contextRevision" + 1,
                 "contextDigest" = ${'b'.repeat(64)},
                 "missionState" = ${JSON.stringify(staleMissionState)}::jsonb,
                 version = version + 1,
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${stale.missionGrant.sessionHandle}
        `;
      });
      const staleMissionBefore = await missionEvidence(stale.missionGrant.sessionHandle);
      const staleTicketBefore = await ticketEvidence(stale.missionGrant.sessionHandle);
      await expect(consumeDirectly(
        stale.missionGrant.sessionHandle,
        stale.created.snapshot.missionConnectionEpoch + 1,
      )).rejects.toThrow('resume ticket consumption lost its exact mission snapshot');
      expect(await missionEvidence(stale.missionGrant.sessionHandle)).toEqual(staleMissionBefore);
      expect(await ticketEvidence(stale.missionGrant.sessionHandle)).toEqual(staleTicketBefore);

      const recovering = await prepareLiveTicket('live_recovering_phase', 'f'.repeat(64));
      const recoveringState = reduceMistralConversationMissionState(
        recovering.created.snapshot.mission,
        { type: 'ROUTE_RECOVERY_STARTED', cancellation: null },
      );
      const recoveringMissionState = {
        ...recoveringState,
        missionConnectionEpoch: recovering.created.snapshot.missionConnectionEpoch + 1,
      };
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET "missionConnectionEpoch" = "missionConnectionEpoch" + 1,
                 phase = ${recoveringState.phase},
                 "missionState" = ${JSON.stringify(recoveringMissionState)}::jsonb,
                 version = version + 1,
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${recovering.missionGrant.sessionHandle}
        `;
      });
      const recoveringMissionBefore = await missionEvidence(recovering.missionGrant.sessionHandle);
      const recoveringTicketBefore = await ticketEvidence(recovering.missionGrant.sessionHandle);
      await expect(consumeDirectly(
        recovering.missionGrant.sessionHandle,
        recovering.created.snapshot.missionConnectionEpoch + 1,
      )).rejects.toThrow('live resume consumption lost its mission or admission fence');
      expect(await missionEvidence(recovering.missionGrant.sessionHandle))
        .toEqual(recoveringMissionBefore);
      expect(await ticketEvidence(recovering.missionGrant.sessionHandle))
        .toEqual(recoveringTicketBefore);
    }, 30_000);

    it('émet un ticket terminal pour une mission fermée et après la frontière H', async () => {
      const closed = await closeMission('terminal_issue_closed');
      const closedTicket = await issueTerminal(
        resumeAuthorities[0],
        closed.grant,
        closed.snapshot,
      );
      expect(new Date(closedTicket.bootstrap.ticketExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(await ticketEvidence(closed.grant.sessionHandle)).toEqual([
        expect.objectContaining({ state: 'issued', version: 1, scope: 'terminal_replay' }),
      ]);

      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const expiredGrant = grant('terminal_issue_after_h', { hardExpiresAt });
      const created = await openMission(
        durableAuthorities[0],
        expiredGrant,
        owner('terminal_issue_after_h'),
      );
      opened(created);
      await waitForDatabaseTime(hardExpiresAt);
      const expiredTicket = await issueTerminal(
        resumeAuthorities[1],
        expiredGrant,
        created.snapshot,
      );
      expect(expiredTicket.bootstrap.scope).toBe('terminal_replay');
      expect((await missionEvidence(expiredGrant.sessionHandle)).phase).toBe('ready');
    }, 30_000);

    it('consomme exactement une fois un ticket terminal sous deux répliques concurrentes', async () => {
      const closed = await closeMission('terminal_one_shot');
      const ticket = await issueTerminal(resumeAuthorities[0], closed.grant, closed.snapshot);
      const results = await Promise.all([
        redeemTerminal(resumeAuthorities[0], ticket),
        redeemTerminal(resumeAuthorities[1], ticket),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        'replayed',
        'terminal_replay',
      ]);
      const winner = results.find((result) => result.status === 'terminal_replay');
      if (!winner || winner.status !== 'terminal_replay') {
        throw new Error('Terminal replay winner missing.');
      }
      expect(winner.events.map((event) => event.type)).toEqual([
        'session.ready',
        'session.draining',
        'session.closed',
      ]);
      expect(await ticketEvidence(closed.grant.sessionHandle)).toEqual([
        expect.objectContaining({
          state: 'consumed',
          version: 2,
          scope: 'terminal_replay',
          consumedMissionConnectionEpoch: closed.snapshot.missionConnectionEpoch,
          replayConnectionId: winner.terminalAcknowledgement.replayConnectionId,
          maxAcknowledgableServerSequence: BigInt(closed.snapshot.nextServerSequence),
        }),
      ]);
    }, 30_000);

    it('relit l’horloge après un verrou ticket qui franchit son expiration', async () => {
      const closed = await closeMission('ticket_lock_wait_expiry');
      const shortAuthority = new PrismaMistralConversationResumeAuthority(
        workers[0],
        durableAuthorities[0],
        {
          policy: {
            ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
            ticketTtlSeconds: 6,
            terminalAcknowledgementTtlSeconds: 6,
          },
        },
      );
      const ticket = await issueTerminal(shortAuthority, closed.grant, closed.snapshot);
      const [shifted] = await admin.$queryRaw<Array<{ expiresAt: Date }>>`
        SELECT clock_timestamp() + interval '2 seconds' AS "expiresAt"
      `;
      if (!shifted) throw new Error('Shifted ticket expiry missing.');
      // Voyage temporel de fixture uniquement : l'émission réelle a respecté la policy 6 s.
      // On raccourcit ensuite la capability pour franchir la borne sous un verrou sans heurter
      // la deadline de transaction Prisma ; l'appel testé reste 100 % runtime/RLS/clock réel.
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_resume_tickets
             SET "expiresAt" = ${shifted.expiresAt}
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${closed.grant.sessionHandle}
        `;
      });
      const beforeMission = await missionEvidence(closed.grant.sessionHandle);
      const beforeTicket = await ticketEvidence(closed.grant.sessionHandle);
      let markLocked: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      let releaseLock: () => void = () => undefined;
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = admin.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id
            FROM realtime_mistral_conversation_resume_tickets
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${closed.grant.sessionHandle}
           FOR UPDATE
        `;
        markLocked();
        await release;
      }, { timeout: 10_000 });
      await locked;
      const redeeming = redeemTerminal(resumeAuthorities[1], ticket);
      await waitForDatabaseTime(shifted.expiresAt.toISOString());
      releaseLock();
      await blocker;

      await expect(redeeming).resolves.toEqual({ status: 'expired' });
      expect(await missionEvidence(closed.grant.sessionHandle)).toEqual(beforeMission);
      expect(await ticketEvidence(closed.grant.sessionHandle)).toEqual(beforeTicket);
    }, 30_000);

    it('rollbacke mission et ticket quand le failpoint jette ou que le signal avorte', async () => {
      for (const mode of ['throw', 'abort'] as const) {
        const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
        const missionGrant = grant(`rollback_${mode}`, { hardExpiresAt });
        const created = await openMission(
          durableAuthorities[0],
          missionGrant,
          owner(`rollback_${mode}`),
        );
        opened(created);
        await waitForDatabaseTime(hardExpiresAt);
        const ticket = await issueTerminal(
          resumeAuthorities[0],
          missionGrant,
          created.snapshot,
        );
        const beforeMission = await missionEvidence(missionGrant.sessionHandle);
        expect(beforeMission.phase).toBe('ready');
        const controller = new AbortController();
        const authority = new PrismaMistralConversationResumeAuthority(
          workers[1],
          durableAuthorities[1],
          {
            beforeTicketConsume: () => {
              if (mode === 'throw') throw new Error('certification failpoint');
              controller.abort();
            },
          },
        );
        const result = await authority.redeemAndOpen({
          companyId,
          ticket: ticket.bootstrap.ticket,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          expectedScope: 'terminal_replay',
          resumeNextServerSequence: ticket.bootstrap.resumeNextServerSequence,
          maxReplayEvents: MAX_REPLAY_EVENTS,
          maxReplayBytes: MAX_REPLAY_BYTES,
          signal: controller.signal,
        });

        expect(result).toEqual({ status: mode === 'throw' ? 'unavailable' : 'aborted' });
        expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(beforeMission);
        expect(await ticketEvidence(missionGrant.sessionHandle)).toEqual([
          expect.objectContaining({
            state: 'issued',
            version: 1,
            consumedMissionConnectionEpoch: null,
            replayConnectionId: null,
            connectionLeaseTokenHash: null,
            maxAcknowledgableServerSequence: null,
          }),
        ]);
      }
    }, 30_000);

    it('ne consomme rien si la fenêtre ACK passe sous six secondes avant le CAS ticket', async () => {
      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const missionGrant = grant('terminal_near_g', { hardExpiresAt });
      const created = await openMission(
        durableAuthorities[0],
        missionGrant,
        owner('terminal_near_g'),
      );
      opened(created);
      await waitForDatabaseTime(hardExpiresAt);
      const ticket = await issueTerminal(
        resumeAuthorities[0],
        missionGrant,
        created.snapshot,
      );
      const [boundaries] = await admin.$queryRaw<Array<{
        replayGraceExpiresAt: Date;
        retentionExpiresAt: Date;
      }>>`
        SELECT clock_timestamp() + interval '9 seconds' AS "replayGraceExpiresAt",
               clock_timestamp() + interval '69 seconds' AS "retentionExpiresAt"
      `;
      if (!boundaries) throw new Error('Near-G boundaries missing.');
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET "replayGraceExpiresAt" = ${boundaries.replayGraceExpiresAt},
                 "retentionExpiresAt" = ${boundaries.retentionExpiresAt},
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_resume_tickets
             SET "replayGraceExpiresAt" = ${boundaries.replayGraceExpiresAt},
                 "expiresAt" = ${boundaries.replayGraceExpiresAt},
                 "retentionExpiresAt" = ${boundaries.retentionExpiresAt}
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
      });
      const beforeMission = await missionEvidence(missionGrant.sessionHandle);
      const beforeTicket = await ticketEvidence(missionGrant.sessionHandle);
      let failpointCalls = 0;
      const authority = new PrismaMistralConversationResumeAuthority(
        workers[1],
        durableAuthorities[1],
        {
          beforeTicketConsume: async () => {
            failpointCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 3_500));
          },
        },
      );

      await expect(redeemTerminal(authority, ticket)).resolves.toEqual({ status: 'expired' });
      expect(failpointCalls).toBe(1);
      await expect(resumeAuthorities[0].issue({
        companyId,
        subjectHash: missionGrant.subjectHash,
        subjectKeyVersion: missionGrant.subjectKeyVersion,
        sessionHandle: missionGrant.sessionHandle,
        clientAcceptedMissionConnectionEpoch: created.snapshot.missionConnectionEpoch,
        resumeNextServerSequence: 0,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'expired' });
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(beforeMission);
      expect(await ticketEvidence(missionGrant.sessionHandle)).toEqual(beforeTicket);
    }, 30_000);

    it('masque ticket et capacité ACK entre tenants sous le rôle runtime réel', async () => {
      const closed = await closeMission('rls_cross_tenant');
      const ticket = await issueTerminal(resumeAuthorities[0], closed.grant, closed.snapshot);

      const hidden = await workers[1].withTenant(otherCompanyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count
            FROM realtime_mistral_conversation_resume_tickets
           WHERE "companyId" = ${companyId}
        `;
        return row?.count ?? -1;
      });
      expect(hidden).toBe(0);
      await expect(resumeAuthorities[1].redeemAndOpen({
        companyId: otherCompanyId,
        ticket: ticket.bootstrap.ticket,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        expectedScope: 'terminal_replay',
        resumeNextServerSequence: ticket.bootstrap.resumeNextServerSequence,
        maxReplayEvents: MAX_REPLAY_EVENTS,
        maxReplayBytes: MAX_REPLAY_BYTES,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'invalid' });

      const replay = await redeemTerminal(resumeAuthorities[0], ticket);
      terminalReplay(replay);
      await expect(resumeAuthorities[1].acknowledgeTerminal({
        companyId: otherCompanyId,
        subjectHash: closed.grant.subjectHash,
        sessionHandle: closed.grant.sessionHandle,
        missionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
        replayConnectionId: replay.terminalAcknowledgement.replayConnectionId,
        connectionLeaseToken: replay.terminalAcknowledgement.connectionLeaseToken,
        nextServerSequence: replay.snapshot.nextServerSequence,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'invalid' });
    });

    it('borne et sérialise l’ACK terminal, refuse secret/max invalides et SQL sans preuve', async () => {
      const closed = await closeMission('terminal_ack');
      const ticket = await issueTerminal(resumeAuthorities[0], closed.grant, closed.snapshot);
      const replay = await redeemTerminal(resumeAuthorities[0], ticket);
      terminalReplay(replay);
      const acknowledgement = replay.terminalAcknowledgement;
      const acknowledgementInput = {
        companyId,
        subjectHash: closed.grant.subjectHash,
        sessionHandle: closed.grant.sessionHandle,
        missionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
        replayConnectionId: acknowledgement.replayConnectionId,
        connectionLeaseToken: acknowledgement.connectionLeaseToken,
        nextServerSequence: replay.snapshot.nextServerSequence,
        signal: new AbortController().signal,
      } as const;
      const before = await missionEvidence(closed.grant.sessionHandle);

      await expect(resumeAuthorities[0].acknowledgeTerminal({
        ...acknowledgementInput,
        connectionLeaseToken: wrongToken(acknowledgement.connectionLeaseToken),
      })).resolves.toEqual({ status: 'invalid' });
      await expect(resumeAuthorities[0].acknowledgeTerminal({
        ...acknowledgementInput,
        nextServerSequence: replay.snapshot.nextServerSequence + 1,
      })).resolves.toEqual({ status: 'invalid' });
      expect(await missionEvidence(closed.grant.sessionHandle)).toEqual(before);

      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET version = version + 1,
                 "acknowledgedServerSequence" = "nextServerSequence",
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${closed.grant.sessionHandle}
        `;
      })).rejects.toThrow('terminal replay ACK must be exact');
      expect(await missionEvidence(closed.grant.sessionHandle)).toEqual(before);

      const concurrent = await Promise.all([
        resumeAuthorities[0].acknowledgeTerminal(acknowledgementInput),
        resumeAuthorities[1].acknowledgeTerminal(acknowledgementInput),
      ]);
      expect(concurrent.map((result) => result.status).sort()).toEqual(['applied', 'replayed']);
      expect(await missionEvidence(closed.grant.sessionHandle)).toEqual({
        ...before,
        version: before.version + 1n,
        acknowledgedServerSequence: before.nextServerSequence,
      });
      await expect(
        resumeAuthorities[0].acknowledgeTerminal(acknowledgementInput),
      ).resolves.toEqual({ status: 'replayed' });
    }, 30_000);

    it('confirme le terminal acquitté sans émettre une nouvelle capability', async () => {
      const closed = await closeMission('terminal_complete');
      const ticket = await issueTerminal(resumeAuthorities[0], closed.grant, closed.snapshot);
      const replay = await redeemTerminal(resumeAuthorities[0], ticket);
      terminalReplay(replay);

      await expect(resumeAuthorities[0].acknowledgeTerminal({
        companyId,
        subjectHash: closed.grant.subjectHash,
        sessionHandle: closed.grant.sessionHandle,
        missionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
        replayConnectionId: replay.terminalAcknowledgement.replayConnectionId,
        connectionLeaseToken: replay.terminalAcknowledgement.connectionLeaseToken,
        nextServerSequence: replay.snapshot.nextServerSequence,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'applied' });

      const ticketsBefore = await ticketEvidence(closed.grant.sessionHandle);
      const terminalComplete = await resumeAuthorities[1].issue({
        companyId,
        subjectHash: closed.grant.subjectHash,
        subjectKeyVersion: closed.grant.subjectKeyVersion,
        sessionHandle: closed.grant.sessionHandle,
        clientAcceptedMissionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
        resumeNextServerSequence: replay.snapshot.nextServerSequence,
        signal: new AbortController().signal,
      });
      expect(terminalComplete).toMatchObject({
        status: 'terminal_complete',
        receipt: {
          companyId,
          sessionHandle: closed.grant.sessionHandle,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          missionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
          nextServerSequence: replay.snapshot.nextServerSequence,
          reason: 'user',
        },
      });
      if (terminalComplete.status !== 'terminal_complete') {
        throw new Error('Expected terminal receipt proof.');
      }
      expect(new Date(terminalComplete.receipt.closedAt).toISOString())
        .toBe(terminalComplete.receipt.closedAt);
      expect(await ticketEvidence(closed.grant.sessionHandle)).toEqual(ticketsBefore);
    }, 30_000);

    it('expire la capacité ACK selon l’horloge PostgreSQL sans avancer le curseur', async () => {
      const shortPolicy = {
        ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
        terminalAcknowledgementTtlSeconds: 6,
      };
      const authority = new PrismaMistralConversationResumeAuthority(
        workers[0],
        durableAuthorities[0],
        { policy: shortPolicy },
      );
      const closed = await closeMission('terminal_ack_ttl');
      const ticket = await issueTerminal(authority, closed.grant, closed.snapshot);
      const replay = await redeemTerminal(authority, ticket);
      terminalReplay(replay);
      const before = await missionEvidence(closed.grant.sessionHandle);
      await waitForDatabaseTime(replay.terminalAcknowledgement.expiresAt);

      await expect(authority.acknowledgeTerminal({
        companyId,
        subjectHash: closed.grant.subjectHash,
        sessionHandle: closed.grant.sessionHandle,
        missionConnectionEpoch: replay.snapshot.missionConnectionEpoch,
        replayConnectionId: replay.terminalAcknowledgement.replayConnectionId,
        connectionLeaseToken: replay.terminalAcknowledgement.connectionLeaseToken,
        nextServerSequence: replay.snapshot.nextServerSequence,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'expired' });
      expect(await missionEvidence(closed.grant.sessionHandle)).toEqual(before);
    }, 30_000);
  },
);
