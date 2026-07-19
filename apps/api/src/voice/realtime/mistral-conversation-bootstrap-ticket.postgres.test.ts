import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionPolicy, RealtimeAdmissionLease } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import { PrismaMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
  hashMistralConversationBootstrapTicket,
  type MistralConversationBootstrapTicketIssueResult,
} from './mistral-conversation-bootstrap-ticket';
import type {
  MistralConversationBootstrapOpenResult,
  MistralConversationDurableOpenResult,
} from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import type { MistralRealtimeIngressIdentityKeyRing } from './realtime-mistral-ingress-ticket';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_CERT === 'true';
const BOOTSTRAP_REAPER_ROLE = 'bob_mistral_bootstrap_reaper';
const CONTEXT = {
  screen: { name: '/devis/new', instanceId: 'quote-new-postgres' },
  entities: [],
  capabilities: ['screen.read' as const],
};
const admissionPolicy: RealtimeAdmissionPolicy = {
  userLimitPerMinute: 20,
  userLimitPerHour: 100,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 120,
  activeLeaseSeconds: 180,
  heartbeatSeconds: 30,
  reaperLeaseSeconds: 30,
};
const identityKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1 ? 'identity-certification-secret-v1'.repeat(2) : null,
};

class CertificationCompletionPort implements MistralConversationCompletionTransactionPort {
  async authorizeAndOpen(
    _tx: Prisma.TransactionClient,
    _input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    return { status: 'opened' };
  }
}

function issued(
  result: MistralConversationBootstrapTicketIssueResult,
): asserts result is Extract<MistralConversationBootstrapTicketIssueResult, { readonly status: 'issued' }> {
  expect(result.status).toBe('issued');
  if (result.status !== 'issued') throw new Error(`Expected issued, received ${result.status}.`);
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral v2 bootstrap — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `bootstrap-v2-${suffix}`;
    const otherCompanyId = `bootstrap-v2-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const completion = new CertificationCompletionPort();
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let admissions: [PrismaRealtimeAdmission, PrismaRealtimeAdmission];
    let durables: [
      PrismaMistralConversationDurableAuthority,
      PrismaMistralConversationDurableAuthority,
    ];
    let bootstraps: [
      PrismaMistralConversationBootstrapTicketAuthority,
      PrismaMistralConversationBootstrapTicketAuthority,
    ];

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral bootstrap PostgreSQL certification ${discriminator}`,
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

    function owner(label: string): string {
      return createHash('sha256')
        .update(`owner:${suffix}:${label}`, 'utf8')
        .digest('base64url');
    }

    async function reserve(worker: number, label: string): Promise<RealtimeAdmissionLease> {
      const result = await admissions[worker]!.reserve({
        companyId,
        subjectHash: createHash('sha256').update(`subject:${suffix}:${label}`, 'utf8').digest('hex'),
        sessionId: randomUUID(),
        maxSessionSeconds: 900,
      });
      if (!result.allowed) throw new Error(`Unexpected admission denial: ${result.denial}`);
      return result.lease;
    }

    async function issue(
      worker: number,
      label: string,
    ): Promise<{
      readonly lease: RealtimeAdmissionLease;
      readonly ticket: Extract<MistralConversationBootstrapTicketIssueResult, {
        readonly status: 'issued';
      }>;
    }> {
      const lease = await reserve(worker, label);
      const result = await bootstraps[worker]!.issue({
        lease,
        userId: `user:${label}`,
        subjectKeyVersion: 1,
        plan: 'pro',
        contextSchemaVersion: 1,
        contextRevision: 1,
        context: CONTEXT,
      });
      issued(result);
      return { lease, ticket: result };
    }

    async function insertRetentionEvidence(
      tenantId: string,
      label: string,
      retentionExpiresAt: Date,
    ): Promise<string> {
      const id = randomUUID();
      const admissionSessionId = randomUUID();
      const issuedAt = new Date(retentionExpiresAt.getTime() - 90_000);
      const ticketExpiresAt = new Date(retentionExpiresAt.getTime() - 60_000);
      const leaseExpiresAt = new Date(retentionExpiresAt.getTime() - 45_000);
      const hardExpiresAt = new Date(retentionExpiresAt.getTime() - 30_000);
      const digest = (domain: string) => createHash('sha256')
        .update(`${domain}:${suffix}:${label}`, 'utf8')
        .digest('hex');
      await admin.$executeRaw`
        INSERT INTO realtime_mistral_conversation_bootstrap_tickets (
          id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
          "subjectKeyVersion", "admissionLeaseTokenHash", "ticketHash", protocol, state, plan,
          "contextSchemaVersion", "contextRevision", "contextSnapshot", "contextDigest",
          "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
          "identityEncryptionKeyVersion", "routeMode", "fullDuplexCertified",
          "maxMissionAudioBytes", "issuedAt", "ticketExpiresAt", "leaseExpiresAt",
          "hardExpiresAt", "consumedAt", "retentionExpiresAt", version, "updatedAt"
        ) VALUES (
          ${id}::uuid, ${tenantId}, ${admissionSessionId}::uuid, ${admissionSessionId},
          ${digest('subject')}, 1, ${digest('lease')}, ${digest('ticket')},
          'bob.mistral-pcm.v2', 'issued', 'pro', 1, 1,
          ${JSON.stringify({ version: 1, revision: 1, context: {} })}::jsonb,
          ${digest('context')}, decode('aa', 'hex'), decode(repeat('11', 12), 'hex'),
          decode(repeat('22', 16), 'hex'), 1, 'push_to_talk', false, 320,
          ${issuedAt}, ${ticketExpiresAt}, ${leaseExpiresAt}, ${hardExpiresAt}, NULL,
          ${retentionExpiresAt}, 1, ${issuedAt}
        )
      `;
      return id;
    }

    async function purgeAsRuntime(batchLimit: number | null): Promise<number> {
      return workers[0].$transaction(async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ purged: number }>>`
          SELECT purge_realtime_mistral_conversation_bootstrap_tickets(
            ${batchLimit}::integer
          ) AS purged
        `;
        return result?.purged ?? -1;
      });
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
      admissions = workers.map((worker) => new PrismaRealtimeAdmission(worker, admissionPolicy)) as typeof admissions;
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      const [floor] = await admin.$queryRaw<Array<{ highestVersion: number }>>`
        SELECT "highestVersion" FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = 'mistral-conversation-persistence-v1'
      `;
      if (!floor || !Number.isInteger(floor.highestVersion) || floor.highestVersion < 1) {
        throw new Error(
          'Le registre de clé Mistral doit être initialisé par le rituel de release avant ce test.',
        );
      }
      const persistenceVersion = floor.highestVersion;
      const persistenceKeys: MistralConversationPersistenceKeyRing = {
        currentVersion: persistenceVersion,
        secret: (version) => version === persistenceVersion
          ? new Uint8Array(32).fill((persistenceVersion % 255) || 1)
          : null,
      };
      durables = workers.map((worker) => new PrismaMistralConversationDurableAuthority(
        worker,
        completion,
        persistenceKeys,
      )) as typeof durables;
      bootstraps = workers.map((worker, index) => new PrismaMistralConversationBootstrapTicketAuthority(
        worker,
        durables[index]!,
        identityKeys,
        DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
      )) as typeof bootstraps;
      await admin.company.createMany({ data: [company(companyId, 1), company(otherCompanyId, 2)] });
    }, 30_000);

    afterAll(async () => {
      // Cette certification mutationnelle s'execute sur une base jetable. Les preuves creees par
      // les scenarios d'autorite restent volontairement jusqu'a leur retention : un test ne doit
      // jamais neutraliser les triggers ou avancer artificiellement l'horloge pour se nettoyer.
      await Promise.allSettled([
        ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('isole le reaper NOLOGIN derrière des fonctions SECURITY DEFINER étroites', async () => {
      const [role] = await admin.$queryRaw<Array<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>>`
        SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit
          FROM pg_roles
         WHERE rolname = ${BOOTSTRAP_REAPER_ROLE}
      `;
      expect(role).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
      });

      const [privileges] = await workers[0].$queryRaw<Array<{
        currentRole: string;
        runtimeCanSetReaper: boolean;
        runtimeCanDelete: boolean;
        runtimeCanExecute: boolean;
        reaperCanSelectTable: boolean;
        reaperCanDelete: boolean;
        reaperCanLockId: boolean;
        reaperCanTruncate: boolean;
        functionOwner: string;
        functionSecurityDefiner: boolean;
        functionConfigHardened: boolean;
      }>>`
          SELECT current_user::text AS "currentRole",
                 pg_has_role(current_user, ${BOOTSTRAP_REAPER_ROLE}::regrole, 'SET')
                   AS "runtimeCanSetReaper",
                 has_table_privilege(current_user,
                   'realtime_mistral_conversation_bootstrap_tickets', 'DELETE')
                   AS "runtimeCanDelete",
                 has_function_privilege(current_user,
                   'purge_realtime_mistral_conversation_bootstrap_tickets(integer)',
                   'EXECUTE') AS "runtimeCanExecute",
                 has_table_privilege(${BOOTSTRAP_REAPER_ROLE}::regrole,
                   'realtime_mistral_conversation_bootstrap_tickets', 'SELECT')
                   AS "reaperCanSelectTable",
                 has_table_privilege(${BOOTSTRAP_REAPER_ROLE}::regrole,
                   'realtime_mistral_conversation_bootstrap_tickets', 'DELETE')
                   AS "reaperCanDelete",
                 has_column_privilege(${BOOTSTRAP_REAPER_ROLE}::regrole,
                   'realtime_mistral_conversation_bootstrap_tickets', 'id', 'UPDATE')
                   AS "reaperCanLockId",
                 has_table_privilege(${BOOTSTRAP_REAPER_ROLE}::regrole,
                   'realtime_mistral_conversation_bootstrap_tickets', 'TRUNCATE')
                   AS "reaperCanTruncate",
                 owner_role.rolname::text AS "functionOwner",
                 target.prosecdef AS "functionSecurityDefiner",
                 target.proconfig @> ARRAY['search_path=pg_catalog', 'row_security=on']::text[]
                   AND cardinality(target.proconfig) = 2 AS "functionConfigHardened"
            FROM pg_proc AS target
            JOIN pg_roles AS owner_role ON owner_role.oid = target.proowner
           WHERE target.oid =
             'purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure
      `;
      expect(privileges).toEqual({
        currentRole: 'bob_app',
        runtimeCanSetReaper: false,
        runtimeCanDelete: false,
        runtimeCanExecute: true,
        reaperCanSelectTable: false,
        reaperCanDelete: true,
        reaperCanLockId: true,
        reaperCanTruncate: false,
        functionOwner: BOOTSTRAP_REAPER_ROLE,
        functionSecurityDefiner: true,
        functionConfigHardened: true,
      });
    });

    it('atteste FORCE RLS, absence de plaintext et atomicité concurrente ticket + mission + outbox', async () => {
      const [role] = await workers[0].$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const [shape] = await workers[0].$queryRaw<Array<{
        rls: boolean;
        forceRls: boolean;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
      }>>`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS "forceRls",
               has_table_privilege(current_user, oid, 'SELECT') AS "canSelect",
               has_table_privilege(current_user, oid, 'INSERT') AS "canInsert",
               has_table_privilege(current_user, oid, 'UPDATE') AS "canUpdate",
               has_table_privilege(current_user, oid, 'DELETE') AS "canDelete",
               has_table_privilege(current_user, oid, 'TRUNCATE') AS "canTruncate"
          FROM pg_class
         WHERE oid = 'realtime_mistral_conversation_bootstrap_tickets'::regclass
      `;
      expect(shape).toEqual({
        rls: true,
        forceRls: true,
        canSelect: true,
        canInsert: true,
        canUpdate: true,
        canDelete: false,
        canTruncate: false,
      });

      const { lease, ticket } = await issue(0, 'concurrent');
      expect(ticket.bootstrap.routeMode).toBe('push_to_talk');
      expect(ticket.bootstrap.fullDuplexCertified).toBe(false);
      const results = await Promise.all(bootstraps.map((bootstrap, index) => bootstrap.redeemAndOpenInitial({
        companyId,
        ticket: ticket.bootstrap.ticket,
        protocol: ticket.bootstrap.protocol,
        ownerLeaseToken: owner(`concurrent-${index}`),
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      })));
      expect(results.filter((result) => result.status === 'opened')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'replayed')).toHaveLength(1);
      const [evidence] = await admin.$queryRaw<Array<{
        state: string;
        ticketHash: string;
        ciphertextText: string;
        missionCount: number;
        outboxCount: number;
      }>>`
        SELECT ticket.state, btrim(ticket."ticketHash") AS "ticketHash",
               encode(ticket."userIdentityCiphertext", 'escape') AS "ciphertextText",
               (SELECT count(*)::int FROM realtime_mistral_conversation_missions mission
                 WHERE mission."companyId" = ticket."companyId"
                   AND mission."initialBootstrapId" = ticket.id) AS "missionCount",
               (SELECT count(*)::int FROM realtime_mistral_conversation_outbox event
                 JOIN realtime_mistral_conversation_missions mission ON mission.id = event."missionId"
                WHERE mission."companyId" = ticket."companyId"
                  AND mission."initialBootstrapId" = ticket.id) AS "outboxCount"
          FROM realtime_mistral_conversation_bootstrap_tickets ticket
         WHERE ticket."companyId" = ${companyId}
           AND ticket."admissionSessionId" = ${lease.sessionId}::uuid
      `;
      expect(evidence).toMatchObject({
        state: 'consumed',
        ticketHash: hashMistralConversationBootstrapTicket(ticket.bootstrap.ticket),
        missionCount: 1,
        outboxCount: 1,
      });
      expect(evidence?.ciphertextText).not.toContain('user:concurrent');
      expect(JSON.stringify(evidence)).not.toContain(ticket.bootstrap.ticket);
      await expect(bootstraps[0].redeemAndOpenInitial({
        companyId: otherCompanyId,
        ticket: ticket.bootstrap.ticket,
        protocol: ticket.bootstrap.protocol,
        ownerLeaseToken: owner('cross-tenant'),
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'invalid' });
    }, 30_000);

    it('purge en batch les seules preuves expirées, tous tenants, sans bypass RLS', async () => {
      const now = Date.now();
      const expiredCompanyId = await insertRetentionEvidence(
        companyId,
        'expired-company',
        new Date(now - 2_000),
      );
      const expiredOtherId = await insertRetentionEvidence(
        otherCompanyId,
        'expired-other',
        new Date(now - 2_000),
      );
      const futureCompanyId = await insertRetentionEvidence(
        companyId,
        'future-company',
        new Date(now + 5_000),
      );
      const futureOtherId = await insertRetentionEvidence(
        otherCompanyId,
        'future-other',
        new Date(now + 60_000),
      );

      const tenantVisibility = await workers[0].withTenant(companyId, async (tx) => {
        const [visible] = await tx.$queryRaw<Array<{ ownCount: number; otherCount: number }>>`
          SELECT count(*) FILTER (WHERE id = ${futureCompanyId}::uuid)::int AS "ownCount",
                 count(*) FILTER (WHERE id = ${futureOtherId}::uuid)::int AS "otherCount"
            FROM realtime_mistral_conversation_bootstrap_tickets
        `;
        return visible;
      });
      expect(tenantVisibility).toEqual({ ownCount: 1, otherCount: 0 });
      const [runtimePurge] = await workers[0].$queryRaw<Array<{ purged: number }>>`
        SELECT purge_realtime_mistral_conversation_bootstrap_tickets(1000) AS purged
      `;
      expect(runtimePurge?.purged).toBeGreaterThanOrEqual(2);

      await expect(admin.$executeRaw`
        DELETE FROM realtime_mistral_conversation_bootstrap_tickets
         WHERE id = ${futureCompanyId}::uuid
      `).rejects.toThrow(/retained mistral conversation bootstrap evidence cannot be deleted/u);

      await purgeAsRuntime(1000);
      const afterFirstPass = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
          FROM realtime_mistral_conversation_bootstrap_tickets
         WHERE id IN (
           ${expiredCompanyId}::uuid, ${expiredOtherId}::uuid,
           ${futureCompanyId}::uuid, ${futureOtherId}::uuid
         )
         ORDER BY id
      `;
      expect(afterFirstPass.map((row) => row.id).sort()).toEqual(
        [futureCompanyId, futureOtherId].sort(),
      );

      await new Promise((resolve) => setTimeout(resolve, 5_200));
      await purgeAsRuntime(1000);
      const [afterExpiry] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_mistral_conversation_bootstrap_tickets
         WHERE id = ${futureCompanyId}::uuid
      `;
      expect(afterExpiry?.count).toBe(0);
      await expect(purgeAsRuntime(0)).rejects.toThrow(
        /bootstrap purge batch must be between 1 and 1000/u,
      );
      await expect(purgeAsRuntime(null)).rejects.toThrow(
        /bootstrap purge batch must be between 1 and 1000/u,
      );

      await expect(workers[0].$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'TRUNCATE TABLE realtime_mistral_conversation_bootstrap_tickets',
        );
      })).rejects.toThrow();
    }, 30_000);

    it('saute une preuve verrouillée et respecte strictement la taille du batch', async () => {
      const firstId = await insertRetentionEvidence(
        companyId,
        'locked-first',
        new Date(Date.now() - 2_000),
      );
      const secondId = await insertRetentionEvidence(
        otherCompanyId,
        'locked-second',
        new Date(Date.now() - 2_000),
      );
      let releaseLock: (() => void) | undefined;
      let signalLocked: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const unlock = new Promise<void>((resolve) => { releaseLock = resolve; });
      const blocker = admin.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE id = ${firstId}::uuid
           FOR UPDATE
        `;
        signalLocked?.();
        await unlock;
      });
      await locked;
      expect(await purgeAsRuntime(1)).toBe(1);
      const beforeUnlock = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
          FROM realtime_mistral_conversation_bootstrap_tickets
         WHERE id IN (${firstId}::uuid, ${secondId}::uuid)
      `;
      expect(beforeUnlock).toEqual([{ id: firstId }]);
      releaseLock?.();
      await blocker;
      expect(await purgeAsRuntime(1)).toBe(1);
    }, 30_000);

    it('rollbacke les écritures Mission/outbox si durable ne rend pas opened', async () => {
      const { lease, ticket } = await issue(0, 'rollback');
      const delegate = durables[0];
      const failingDurable = {
        openWithinTransaction: async (
          tx: Prisma.TransactionClient,
          input: Parameters<PrismaMistralConversationDurableAuthority['openWithinTransaction']>[1],
        ): Promise<MistralConversationDurableOpenResult> => {
          const result = await delegate.openWithinTransaction(tx, input);
          if (result.status !== 'opened') return result;
          return { status: 'conflict' };
        },
      } as unknown as PrismaMistralConversationDurableAuthority;
      const failing = new PrismaMistralConversationBootstrapTicketAuthority(
        workers[0],
        failingDurable,
        identityKeys,
      );
      const result = await failing.redeemAndOpenInitial({
        companyId,
        ticket: ticket.bootstrap.ticket,
        protocol: ticket.bootstrap.protocol,
        ownerLeaseToken: owner('rollback-failing'),
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ status: 'unavailable' });
      const [evidence] = await admin.$queryRaw<Array<{
        state: string;
        missionCount: number;
        outboxCount: number;
      }>>`
        SELECT ticket.state,
               (SELECT count(*)::int FROM realtime_mistral_conversation_missions mission
                 WHERE mission."initialBootstrapId" = ticket.id) AS "missionCount",
               (SELECT count(*)::int FROM realtime_mistral_conversation_outbox event
                 JOIN realtime_mistral_conversation_missions mission ON mission.id = event."missionId"
                WHERE mission."initialBootstrapId" = ticket.id) AS "outboxCount"
          FROM realtime_mistral_conversation_bootstrap_tickets ticket
         WHERE ticket."companyId" = ${companyId}
           AND ticket."admissionSessionId" = ${lease.sessionId}::uuid
      `;
      expect(evidence).toEqual({ state: 'issued', missionCount: 0, outboxCount: 0 });
      const retry = await bootstraps[0].redeemAndOpenInitial({
        companyId,
        ticket: ticket.bootstrap.ticket,
        protocol: ticket.bootstrap.protocol,
        ownerLeaseToken: owner('rollback-retry'),
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: new AbortController().signal,
      });
      expect(retry.status).toBe('opened');
    }, 30_000);

    it('rollbacke aussi sur abort observé après la création durable', async () => {
      const { lease, ticket } = await issue(0, 'abort');
      const controller = new AbortController();
      const delegate = durables[0];
      const abortingDurable = {
        openWithinTransaction: async (
          tx: Prisma.TransactionClient,
          input: Parameters<PrismaMistralConversationDurableAuthority['openWithinTransaction']>[1],
        ): Promise<MistralConversationDurableOpenResult> => {
          const result = await delegate.openWithinTransaction(tx, input);
          controller.abort();
          return result;
        },
      } as unknown as PrismaMistralConversationDurableAuthority;
      const aborting = new PrismaMistralConversationBootstrapTicketAuthority(
        workers[0],
        abortingDurable,
        identityKeys,
      );
      const result: MistralConversationBootstrapOpenResult = await aborting.redeemAndOpenInitial({
        companyId,
        ticket: ticket.bootstrap.ticket,
        protocol: ticket.bootstrap.protocol,
        ownerLeaseToken: owner('abort-after-open'),
        resumeNextServerSequence: 0,
        maxReplayEvents: 256,
        maxReplayBytes: 240 * 1024,
        signal: controller.signal,
      });
      expect(result).toEqual({ status: 'aborted' });
      const [evidence] = await admin.$queryRaw<Array<{ state: string; missionCount: number }>>`
        SELECT ticket.state,
               (SELECT count(*)::int FROM realtime_mistral_conversation_missions mission
                 WHERE mission."initialBootstrapId" = ticket.id) AS "missionCount"
          FROM realtime_mistral_conversation_bootstrap_tickets ticket
         WHERE ticket."companyId" = ${companyId}
           AND ticket."admissionSessionId" = ${lease.sessionId}::uuid
      `;
      expect(evidence).toEqual({ state: 'issued', missionCount: 0 });
    }, 30_000);
  },
);
