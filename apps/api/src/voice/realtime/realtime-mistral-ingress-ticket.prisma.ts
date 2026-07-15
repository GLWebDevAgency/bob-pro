import type { PlanTier } from '@bob/core';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  hashRealtimeLeaseToken,
  isRealtimeCompanyId,
  isRealtimeLeaseCredential,
  isRealtimeProviderCallId,
  isRealtimeSessionId,
  prepareRealtimeContext,
} from './realtime-admission';
import {
  MISTRAL_PCM_GATEWAY_PROTOCOL,
} from './mistral-realtime-gateway';
import {
  MISTRAL_REALTIME_MAX_CONTEXT_REVISION,
  MISTRAL_REALTIME_PCM_BYTES_PER_SECOND,
  hashMistralRealtimeIngressTicket,
  isMistralRealtimeIngressTicket,
  openMistralRealtimeUserIdentity,
  sealMistralRealtimeUserIdentity,
  secureMistralRealtimeIngressTicketEntropy,
  validateMistralRealtimeIngressIdentityKeyRing,
  validateMistralRealtimeIngressTicketPolicy,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressGrant,
  type MistralRealtimeIngressIdentityKeyRing,
  type MistralRealtimeIngressTicketAuthority,
  type MistralRealtimeIngressTicketEntropy,
  type MistralRealtimeIngressTicketIssueInput,
  type MistralRealtimeIngressTicketIssueResult,
  type MistralRealtimeIngressTicketPolicy,
  type MistralRealtimeTicketConsumeResult,
} from './realtime-mistral-ingress-ticket';

const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[a-f0-9]{64}$/u;

class MistralIngressTransactionAbort extends Error {}

interface DatabaseClockRow {
  databaseNow: Date;
}

interface IssueLeaseRow {
  subjectHash: string;
  sessionId: string;
  leaseTokenHash: string;
  state: string;
  providerId: string | null;
  providerCallId: string | null;
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  contextSchemaVersion: number | null;
  contextRevision: number | null;
  contextPayload: unknown | null;
  contextDigest: string | null;
}

interface TicketRow {
  id: string;
  companyId: string;
  subjectHash: string;
  subjectKeyVersion: number;
  sessionId: string;
  state: string;
  plan: PlanTier;
  contextRevision: number;
  contextDigest: string;
  userIdentityCiphertext: Uint8Array;
  userIdentityNonce: Uint8Array;
  userIdentityTag: Uint8Array;
  identityEncryptionKeyVersion: number;
  maxAudioBytes: number;
  providerSessionId: string | null;
  providerTermination: 'confirmed' | 'not_created' | 'unconfirmed' | null;
  ticketExpiresAt: Date;
  bindingExpiresAt: Date | null;
  hardExpiresAt: Date;
  consumedAt: Date | null;
  activatedAt: Date | null;
  finishedAt: Date | null;
  version: number;
}

interface QuotaRow {
  outstanding: number;
  issuedHour: number;
}

interface TicketExpiryRow {
  ticketExpiresAt: Date;
}

interface TerminalLeaseRow {
  state: string;
  providerId: string | null;
  providerCallId: string | null;
  leaseExpiresAt: Date;
  hardExpiresAt: Date;
  contextRevision: number | null;
  contextDigest: string | null;
  contextAppliedRevision: number | null;
  contextAppliedDigest: string | null;
  contextAppliedOwnerEpoch: number | null;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string | null;
  sidebandOwnerLeaseExpiresAt: Date | null;
  sidebandProtocolVersion: number | null;
}

interface DeliveryArtifactRow {
  state: 'ready' | 'delivered' | 'cancelled';
  storageExpiresAt: Date | null;
  contextRevision: number;
  contextDigest: string;
  sidebandOwnerEpoch: number;
  sidebandOwnerTokenHash: string;
}

function cleanHash(value: string): string {
  return value.trim();
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MISTRAL_REALTIME_MAX_CONTEXT_REVISION;
}

function validIssueInput(input: MistralRealtimeIngressTicketIssueInput): boolean {
  return isRealtimeLeaseCredential(input)
    && typeof input.userId === 'string'
    && input.userId.length >= 1
    && input.userId.length <= 256
    && Buffer.byteLength(input.userId, 'utf8') <= 512
    && validVersion(input.subjectKeyVersion)
    && PLANS.has(input.plan)
    && input.contextSchemaVersion === 1
    && validVersion(input.contextRevision);
}

function validRedemptionInput(input: {
  companyId: string;
  redemptionId: string;
  providerSessionId: string;
}): boolean {
  return isRealtimeCompanyId(input.companyId)
    && UUID.test(input.redemptionId)
    && isRealtimeProviderCallId(input.providerSessionId);
}

function identityBinding(row: Pick<
TicketRow,
  'companyId' | 'subjectHash' | 'subjectKeyVersion' | 'sessionId' | 'id' | 'plan' | 'contextRevision' | 'contextDigest'
>): MistralRealtimeIdentityBinding {
  return {
    companyId: row.companyId,
    subjectHash: cleanHash(row.subjectHash),
    subjectKeyVersion: row.subjectKeyVersion,
    sessionId: row.sessionId,
    redemptionId: row.id,
    plan: row.plan,
    contextRevision: row.contextRevision,
    contextDigest: cleanHash(row.contextDigest),
  };
}

function asBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

/**
 * Autorité PostgreSQL sans fallback mémoire. Toutes les recherches sont précédées du localisateur
 * tenant et exécutées sous `withTenant`; le hash du ticket n'est jamais utilisé comme lookup global.
 */
export class PrismaMistralRealtimeIngressTicketAuthority
implements MistralRealtimeIngressTicketAuthority {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: MistralRealtimeIngressTicketPolicy,
    private readonly identityKeys: MistralRealtimeIngressIdentityKeyRing,
    private readonly entropy: MistralRealtimeIngressTicketEntropy = secureMistralRealtimeIngressTicketEntropy,
  ) {
    validateMistralRealtimeIngressTicketPolicy(policy);
    validateMistralRealtimeIngressIdentityKeyRing(identityKeys);
  }

  async issue(
    input: MistralRealtimeIngressTicketIssueInput,
  ): Promise<MistralRealtimeIngressTicketIssueResult> {
    if (!validIssueInput(input)) return { ok: false, reason: 'rejected' };
    const prepared = prepareRealtimeContext({
      version: input.contextSchemaVersion,
      revision: input.contextRevision,
      context: input.context,
    });
    if (!prepared) return { ok: false, reason: 'rejected' };
    const ticket = this.entropy.ticket();
    const redemptionId = this.entropy.redemptionId();
    if (!isMistralRealtimeIngressTicket(ticket) || !isRealtimeSessionId(redemptionId)) {
      return { ok: false, reason: 'unavailable' };
    }
    const binding: MistralRealtimeIdentityBinding = {
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      subjectKeyVersion: input.subjectKeyVersion,
      sessionId: input.sessionId,
      redemptionId,
      plan: input.plan,
      contextRevision: prepared.snapshot.revision,
      contextDigest: prepared.digest,
    };
    let identity: ReturnType<typeof sealMistralRealtimeUserIdentity>;
    try {
      identity = sealMistralRealtimeUserIdentity(input.userId, binding, this.identityKeys);
    } catch {
      return { ok: false, reason: 'rejected' };
    }

    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockTenant(tx, input.companyId);
        await tx.$executeRaw`
          DELETE FROM realtime_mistral_ingress_tickets
           WHERE "companyId" = ${input.companyId}
             AND "retentionExpiresAt" <= clock_timestamp()
        `;
        const [{ databaseNow }] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!databaseNow) return { ok: false as const, reason: 'unavailable' as const };
        const [quota] = await tx.$queryRaw<QuotaRow[]>`
          SELECT
            count(*) FILTER (
              WHERE state IN ('issued', 'consumed', 'active')
                AND "hardExpiresAt" > ${databaseNow}
            )::int AS outstanding,
            count(*) FILTER (
              WHERE "issuedAt" > ${databaseNow} - interval '1 hour'
            )::int AS "issuedHour"
            FROM realtime_mistral_ingress_tickets
           WHERE "companyId" = ${input.companyId}
        `;
        if (!quota) return { ok: false as const, reason: 'unavailable' as const };
        if (
          quota.outstanding >= this.policy.maxOutstandingPerTenant
          || quota.issuedHour >= this.policy.maxIssuesPerTenantHour
        ) return { ok: false as const, reason: 'quota' as const };

        const [lease] = await tx.$queryRaw<IssueLeaseRow[]>`
          SELECT "subjectHash", "sessionId", "leaseTokenHash", state, "providerId", "providerCallId",
                 "leaseExpiresAt", "hardExpiresAt", "contextSchemaVersion", "contextRevision",
                 "contextPayload", "contextDigest"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR UPDATE
        `;
        if (!lease || cleanHash(lease.leaseTokenHash) !== hashRealtimeLeaseToken(input.leaseToken)) {
          return { ok: false as const, reason: 'rejected' as const };
        }
        if (
          lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || lease.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { ok: false as const, reason: 'expired' as const };
        if (
          cleanHash(lease.subjectHash) !== input.subjectHash
          || lease.sessionId.toLowerCase() !== input.sessionId.toLowerCase()
          || lease.state !== 'reserved'
          || lease.providerId !== null
          || lease.providerCallId !== null
          || lease.contextSchemaVersion !== null
          || lease.contextRevision !== null
          || lease.contextPayload !== null
          || lease.contextDigest !== null
        ) return { ok: false as const, reason: 'rejected' as const };

        const remainingSeconds = Math.max(
          1,
          Math.floor((lease.hardExpiresAt.getTime() - databaseNow.getTime()) / 1_000),
        );
        const maxAudioBytes = Math.min(
          this.policy.maxAudioBytes,
          remainingSeconds * MISTRAL_REALTIME_PCM_BYTES_PER_SECOND,
        );
        const contextUpdated = await tx.$executeRaw`
          UPDATE realtime_session_leases
             SET "contextSchemaVersion" = ${prepared.snapshot.version},
                 "contextRevision" = ${prepared.snapshot.revision},
                 "contextPayload" = ${prepared.serialized}::jsonb,
                 "contextDigest" = ${prepared.digest},
                 "contextUpdatedAt" = ${databaseNow},
                 "updatedAt" = ${databaseNow},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.sessionId}::uuid
             AND "leaseTokenHash" = ${hashRealtimeLeaseToken(input.leaseToken)}
             AND state = 'reserved'
             AND "providerId" IS NULL
             AND "providerCallId" IS NULL
             AND "leaseExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
             AND "contextSchemaVersion" IS NULL
             AND "contextRevision" IS NULL
             AND "contextPayload" IS NULL
             AND "contextDigest" IS NULL
             AND "contextUpdatedAt" IS NULL
        `;
        if (contextUpdated !== 1) return { ok: false as const, reason: 'unavailable' as const };

        const [inserted] = await tx.$queryRaw<TicketExpiryRow[]>`
          INSERT INTO realtime_mistral_ingress_tickets (
            id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", "ticketHash",
            protocol, state, plan, "contextSchemaVersion", "contextRevision", "contextDigest",
            "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
            "identityEncryptionKeyVersion", "maxAudioBytes", "issuedAt", "ticketExpiresAt",
            "hardExpiresAt", "retentionExpiresAt", version
          ) VALUES (
            ${redemptionId}::uuid, ${input.companyId}, ${input.subjectHash}, ${input.subjectKeyVersion},
            ${input.sessionId}::uuid, ${hashMistralRealtimeIngressTicket(ticket)},
            ${MISTRAL_PCM_GATEWAY_PROTOCOL}, 'issued', ${input.plan}, ${prepared.snapshot.version},
            ${prepared.snapshot.revision}, ${prepared.digest}, ${Buffer.from(identity.ciphertext)},
            ${Buffer.from(identity.nonce)}, ${Buffer.from(identity.tag)}, ${identity.keyVersion},
            ${maxAudioBytes}, ${databaseNow},
            LEAST(
              ${databaseNow} + make_interval(secs => ${this.policy.ticketTtlSeconds}),
              ${lease.leaseExpiresAt}, ${lease.hardExpiresAt}
            ),
            ${lease.hardExpiresAt},
            ${lease.hardExpiresAt} + make_interval(secs => ${this.policy.retentionSeconds}), 1
          )
          RETURNING "ticketExpiresAt"
        `;
        if (!inserted) throw new MistralIngressTransactionAbort();
        return {
          ok: true as const,
          bootstrap: {
            companyId: input.companyId,
            sessionId: input.sessionId,
            ticket,
            protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
            ticketExpiresAt: inserted.ticketExpiresAt.toISOString(),
            hardExpiresAt: lease.hardExpiresAt.toISOString(),
            maxAudioBytes,
            contextRevision: prepared.snapshot.revision,
            contextDigest: prepared.digest,
          },
        };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async consume(input: {
    readonly companyId: string;
    readonly ticket: string;
    readonly protocol: typeof MISTRAL_PCM_GATEWAY_PROTOCOL;
  }): Promise<MistralRealtimeTicketConsumeResult> {
    if (
      !isRealtimeCompanyId(input.companyId)
      || !isMistralRealtimeIngressTicket(input.ticket)
      || input.protocol !== MISTRAL_PCM_GATEWAY_PROTOCOL
    ) return { ok: false, reason: 'invalid' };
    const ticketHash = hashMistralRealtimeIngressTicket(input.ticket);
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<TicketRow[]>`
          SELECT id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", state, plan,
                 "contextRevision", "contextDigest", "userIdentityCiphertext", "userIdentityNonce",
                 "userIdentityTag", "identityEncryptionKeyVersion", "maxAudioBytes",
                 "providerSessionId", "providerTermination", "ticketExpiresAt", "bindingExpiresAt",
                 "hardExpiresAt", "consumedAt", "activatedAt", "finishedAt", version
            FROM realtime_mistral_ingress_tickets
           WHERE "companyId" = ${input.companyId}
             AND "ticketHash" = ${ticketHash}
             AND protocol = ${MISTRAL_PCM_GATEWAY_PROTOCOL}
           FOR UPDATE
        `;
        if (!row) return { ok: false as const, reason: 'invalid' as const };
        if (row.state !== 'issued') return { ok: false as const, reason: 'replayed' as const };
        const [{ databaseNow }] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!databaseNow) return { ok: false as const, reason: 'unavailable' as const };
        if (
          row.ticketExpiresAt.getTime() <= databaseNow.getTime()
          || row.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { ok: false as const, reason: 'expired' as const };

        const [lease] = await tx.$queryRaw<Array<{
          state: string;
          providerId: string | null;
          providerCallId: string | null;
          leaseExpiresAt: Date;
          hardExpiresAt: Date;
          contextRevision: number | null;
          contextDigest: string | null;
        }>>`
          SELECT state, "providerId", "providerCallId", "leaseExpiresAt", "hardExpiresAt",
                 "contextRevision", "contextDigest"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${cleanHash(row.subjectHash)}
             AND "sessionId" = ${row.sessionId}::uuid
           FOR UPDATE
        `;
        if (
          !lease
          || lease.state !== 'reserved'
          || lease.providerId !== null
          || lease.providerCallId !== null
          || lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || lease.hardExpiresAt.getTime() !== row.hardExpiresAt.getTime()
          || lease.contextRevision !== row.contextRevision
          || cleanHash(lease.contextDigest ?? '') !== cleanHash(row.contextDigest)
        ) return { ok: false as const, reason: 'unavailable' as const };

        const userId = openMistralRealtimeUserIdentity({
          ciphertext: asBytes(row.userIdentityCiphertext),
          nonce: asBytes(row.userIdentityNonce),
          tag: asBytes(row.userIdentityTag),
          keyVersion: row.identityEncryptionKeyVersion,
        }, identityBinding(row), this.identityKeys);
        if (userId === null) return { ok: false as const, reason: 'unavailable' as const };

        const [extended] = await tx.$queryRaw<Array<{ bindingExpiresAt: Date }>>`
          UPDATE realtime_session_leases
             SET "leaseExpiresAt" = LEAST(
                   ${databaseNow} + make_interval(secs => ${this.policy.activationTtlSeconds}),
                   "hardExpiresAt"
                 ),
                 "updatedAt" = ${databaseNow}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${cleanHash(row.subjectHash)}
             AND "sessionId" = ${row.sessionId}::uuid
             AND state = 'reserved'
             AND "providerId" IS NULL
             AND "providerCallId" IS NULL
             AND "leaseExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
             AND "contextRevision" = ${row.contextRevision}
             AND "contextDigest" = ${cleanHash(row.contextDigest)}
          RETURNING "leaseExpiresAt" AS "bindingExpiresAt"
        `;
        if (!extended) return { ok: false as const, reason: 'unavailable' as const };
        const consumed = await tx.$executeRaw`
          UPDATE realtime_mistral_ingress_tickets
             SET state = 'consumed', "consumedAt" = ${databaseNow},
                 "bindingExpiresAt" = ${extended.bindingExpiresAt}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND id = ${row.id}::uuid
             AND state = 'issued'
             AND version = ${row.version}
             AND "ticketExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
        `;
        if (consumed !== 1) throw new MistralIngressTransactionAbort();
        const grant: MistralRealtimeIngressGrant = {
          redemptionId: row.id,
          companyId: input.companyId,
          userId,
          subjectHash: cleanHash(row.subjectHash),
          subjectKeyVersion: row.subjectKeyVersion,
          plan: row.plan,
          sessionId: row.sessionId,
          contextRevision: row.contextRevision,
          contextDigest: cleanHash(row.contextDigest),
          hardExpiresAt: row.hardExpiresAt.toISOString(),
          maxAudioBytes: row.maxAudioBytes,
        };
        return { ok: true as const, grant };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async bindAndActivate(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerId: 'mistral';
    readonly providerSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'rejected' | 'unavailable' }> {
    if (
      !validRedemptionInput(input)
      || input.providerId !== 'mistral'
      || !validVersion(input.contextRevision)
      || !DIGEST.test(input.contextDigest)
    ) return { ok: false, reason: 'rejected' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [ticket] = await this.lockTicketById(tx, input.companyId, input.redemptionId);
        if (!ticket) return { ok: false as const, reason: 'rejected' as const };
        if (
          ticket.contextRevision !== input.contextRevision
          || cleanHash(ticket.contextDigest) !== input.contextDigest
        ) return { ok: false as const, reason: 'rejected' as const };
        const [{ databaseNow }] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!databaseNow) return { ok: false as const, reason: 'unavailable' as const };

        if (ticket.state === 'active') {
          if (ticket.providerSessionId !== input.providerSessionId) {
            return { ok: false as const, reason: 'rejected' as const };
          }
          const [lease] = await tx.$queryRaw<Array<{ present: boolean }>>`
            SELECT true AS present
              FROM realtime_session_leases
             WHERE "companyId" = ${input.companyId}
               AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
               AND "sessionId" = ${ticket.sessionId}::uuid
               AND state = 'active'
               AND "providerId" = 'mistral'
               AND "providerCallId" = ${input.providerSessionId}
               AND "contextRevision" = ${input.contextRevision}
               AND "contextDigest" = ${input.contextDigest}
               AND "leaseExpiresAt" > ${databaseNow}
               AND "hardExpiresAt" > ${databaseNow}
             FOR SHARE
          `;
          return lease ? { ok: true as const } : { ok: false as const, reason: 'unavailable' as const };
        }
        if (
          ticket.state !== 'consumed'
          || ticket.bindingExpiresAt === null
          || ticket.bindingExpiresAt.getTime() <= databaseNow.getTime()
          || ticket.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { ok: false as const, reason: 'rejected' as const };

        const bound = await tx.$executeRaw`
          UPDATE realtime_session_leases
             SET state = 'bound', "providerId" = 'mistral',
                 "providerCallId" = ${input.providerSessionId},
                 "updatedAt" = ${databaseNow}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
             AND "sessionId" = ${ticket.sessionId}::uuid
             AND state = 'reserved'
             AND "providerId" IS NULL
             AND "providerCallId" IS NULL
             AND "leaseExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
             AND "contextRevision" = ${input.contextRevision}
             AND "contextDigest" = ${input.contextDigest}
        `;
        if (bound !== 1) return { ok: false as const, reason: 'rejected' as const };
        const activated = await tx.$executeRaw`
          UPDATE realtime_session_leases
             SET state = 'active', "activatedAt" = ${databaseNow},
                 "leaseExpiresAt" = "hardExpiresAt", "updatedAt" = ${databaseNow},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
             AND "sessionId" = ${ticket.sessionId}::uuid
             AND state = 'bound'
             AND "providerId" = 'mistral'
             AND "providerCallId" = ${input.providerSessionId}
             AND "contextRevision" = ${input.contextRevision}
             AND "contextDigest" = ${input.contextDigest}
             AND "hardExpiresAt" > ${databaseNow}
        `;
        if (activated !== 1) throw new MistralIngressTransactionAbort();
        const ticketActivated = await tx.$executeRaw`
          UPDATE realtime_mistral_ingress_tickets
             SET state = 'active', "providerSessionId" = ${input.providerSessionId},
                 "activatedAt" = ${databaseNow}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND id = ${input.redemptionId}::uuid
             AND state = 'consumed'
             AND version = ${ticket.version}
             AND "bindingExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
        `;
        if (ticketActivated !== 1) throw new MistralIngressTransactionAbort();
        return { ok: true as const };
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async abandon(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerSessionId: string | null;
    readonly providerTermination: 'confirmed' | 'not_created' | 'unconfirmed';
  }): Promise<void> {
    const providerShape = input.providerTermination === 'not_created'
      ? input.providerSessionId === null
      : input.providerSessionId !== null && isRealtimeProviderCallId(input.providerSessionId);
    if (!isRealtimeCompanyId(input.companyId) || !UUID.test(input.redemptionId) || !providerShape) {
      throw new Error('Mistral realtime ingress abandonment rejected.');
    }
    try {
      const completed = await this.prisma.withTenant(input.companyId, async (tx) => {
        const [ticket] = await this.lockTicketById(tx, input.companyId, input.redemptionId);
        if (!ticket) return false;
        if (ticket.state === 'abandoned') {
          return ticket.providerSessionId === input.providerSessionId
            && ticket.providerTermination === input.providerTermination;
        }
        if (ticket.state === 'completed' || (ticket.state !== 'consumed' && ticket.state !== 'active')) {
          return false;
        }
        if (
          ticket.state === 'active'
          && (
            input.providerTermination === 'not_created'
            || ticket.providerSessionId !== input.providerSessionId
          )
        ) return false;
        const [{ databaseNow }] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!databaseNow) return false;

        if (input.providerTermination === 'unconfirmed') {
          if (ticket.state === 'consumed') {
            const bound = await tx.$executeRaw`
              UPDATE realtime_session_leases
                 SET state = 'bound', "providerId" = 'mistral',
                     "providerCallId" = ${input.providerSessionId!},
                     "leaseExpiresAt" = GREATEST(
                       "reservedAt" + interval '1 microsecond', ${databaseNow}
                     ),
                     "updatedAt" = ${databaseNow}, version = version + 1
               WHERE "companyId" = ${input.companyId}
                 AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
                 AND "sessionId" = ${ticket.sessionId}::uuid
                 AND state = 'reserved'
                 AND "providerId" IS NULL
                 AND "providerCallId" IS NULL
                 AND "contextRevision" = ${ticket.contextRevision}
                 AND "contextDigest" = ${cleanHash(ticket.contextDigest)}
            `;
            if (bound !== 1) return false;
          } else {
            const expired = await tx.$executeRaw`
              UPDATE realtime_session_leases
                 SET "leaseExpiresAt" = GREATEST(
                       "reservedAt" + interval '1 microsecond', ${databaseNow}
                     ),
                     "updatedAt" = ${databaseNow}, version = version + 1
               WHERE "companyId" = ${input.companyId}
                 AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
                 AND "sessionId" = ${ticket.sessionId}::uuid
                 AND state = 'active'
                 AND "providerId" = 'mistral'
                 AND "providerCallId" = ${input.providerSessionId!}
            `;
            if (expired !== 1) {
              const lease = await this.lockLeaseForTerminal(tx, ticket);
              if (
                lease
                && (
                  lease.state !== 'reaping'
                  || lease.providerId !== 'mistral'
                  || lease.providerCallId !== input.providerSessionId
                  || lease.contextRevision !== ticket.contextRevision
                  || cleanHash(lease.contextDigest ?? '') !== cleanHash(ticket.contextDigest)
                )
              ) return false;
              // `null` signifie que le reaper a déjà confirmé puis supprimé le bail. Dans les
              // deux cas (reaping ou absent), aucune identité provider ne doit être recréée.
            }
          }
        }

        const terminal = await tx.$executeRaw`
          UPDATE realtime_mistral_ingress_tickets
             SET state = 'abandoned', "providerSessionId" = ${input.providerSessionId},
                 "providerTermination" = ${input.providerTermination},
                 "finishedAt" = ${databaseNow}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND id = ${input.redemptionId}::uuid
             AND state = ${ticket.state}
             AND version = ${ticket.version}
        `;
        if (terminal !== 1) throw new MistralIngressTransactionAbort();

        if (input.providerTermination !== 'unconfirmed') {
          const deleted = await tx.$executeRaw`
            DELETE FROM realtime_session_leases
             WHERE "companyId" = ${input.companyId}
               AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
               AND "sessionId" = ${ticket.sessionId}::uuid
               AND (
                 (${input.providerTermination === 'not_created'} AND state = 'reserved'
                   AND "providerId" IS NULL AND "providerCallId" IS NULL)
                 OR
                 (${input.providerTermination === 'confirmed'} AND (
                   (state = 'reserved' AND "providerId" IS NULL AND "providerCallId" IS NULL)
                   OR (state IN ('bound', 'active') AND "providerId" = 'mistral'
                     AND "providerCallId" = ${input.providerSessionId})
                 ))
               )
          `;
          if (deleted !== 1) {
            const lease = await this.lockLeaseForTerminal(tx, ticket);
            const reaperOwnsConfirmedProvider = input.providerTermination === 'confirmed'
              && lease?.state === 'reaping'
              && lease.providerId === 'mistral'
              && lease.providerCallId === input.providerSessionId
              && lease.contextRevision === ticket.contextRevision
              && cleanHash(lease.contextDigest ?? '') === cleanHash(ticket.contextDigest);
            // Bail absent : un cleanup/reaper l'a déjà supprimé. Bail `reaping` : son fence reste
            // seul propriétaire de la terminaison ; on persiste le terminal sans le court-circuiter.
            if (lease && !reaperOwnsConfirmedProvider) throw new MistralIngressTransactionAbort();
          }
        }
        return true;
      });
      if (!completed) throw new Error('Mistral realtime ingress abandonment rejected.');
    } catch {
      throw new Error('Mistral realtime ingress abandonment unavailable.');
    }
  }

  async complete(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerSessionId: string;
    readonly providerTermination: 'confirmed';
  }): Promise<void> {
    if (!validRedemptionInput(input) || input.providerTermination !== 'confirmed') {
      throw new Error('Mistral realtime ingress completion rejected.');
    }
    try {
      const completed = await this.prisma.withTenant(input.companyId, async (tx) => {
        const [ticket] = await this.lockTicketById(tx, input.companyId, input.redemptionId);
        if (!ticket) return false;
        if (ticket.state === 'completed') {
          return ticket.providerSessionId === input.providerSessionId
            && ticket.providerTermination === 'confirmed';
        }
        if (ticket.state !== 'active' || ticket.providerSessionId !== input.providerSessionId) return false;
        // Ordre de locks partagé avec l'ACK HTTP : ticket -> artefact -> lease. Sans cet ordre,
        // complete et ready->delivered pourraient se bloquer mutuellement entre deux répliques.
        const [artifact] = await this.lockDeliveryArtifact(tx, ticket);
        if (!artifact) return false;
        const lease = await this.lockLeaseForTerminal(tx, ticket);
        if (
          !lease
          || lease.state !== 'active'
          || lease.providerId !== 'mistral'
          || lease.providerCallId !== input.providerSessionId
          || lease.contextRevision !== ticket.contextRevision
          || cleanHash(lease.contextDigest ?? '') !== cleanHash(ticket.contextDigest)
          || artifact.contextRevision !== ticket.contextRevision
          || cleanHash(artifact.contextDigest) !== cleanHash(ticket.contextDigest)
          || artifact.sidebandOwnerEpoch !== lease.sidebandOwnerEpoch
          || cleanHash(artifact.sidebandOwnerTokenHash)
            !== cleanHash(lease.sidebandOwnerTokenHash ?? '')
        ) return false;
        const [{ databaseNow }] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!databaseNow) return false;

        if (artifact.state === 'ready') {
          const ownerExpiresAt = lease.sidebandOwnerLeaseExpiresAt;
          const storageExpiresAt = artifact.storageExpiresAt;
          if (
            !(ownerExpiresAt instanceof Date)
            || !(storageExpiresAt instanceof Date)
            || lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
            || lease.hardExpiresAt.getTime() <= databaseNow.getTime()
            || ownerExpiresAt.getTime() <= databaseNow.getTime()
            || storageExpiresAt.getTime() <= databaseNow.getTime()
            || lease.contextAppliedRevision !== ticket.contextRevision
            || cleanHash(lease.contextAppliedDigest ?? '') !== cleanHash(ticket.contextDigest)
            || lease.contextAppliedOwnerEpoch !== lease.sidebandOwnerEpoch
            || lease.sidebandProtocolVersion !== 2
          ) return false;
          const deliveryExpiresAt = new Date(Math.min(
            databaseNow.getTime() + this.policy.deliveryGraceSeconds * 1_000,
            storageExpiresAt.getTime(),
            lease.hardExpiresAt.getTime(),
            ownerExpiresAt.getTime(),
          ));
          if (deliveryExpiresAt.getTime() <= databaseNow.getTime()) return false;
          const drained = await tx.$executeRaw`
            UPDATE realtime_session_leases
               SET "leaseExpiresAt" = ${deliveryExpiresAt},
                   "updatedAt" = ${databaseNow}, version = version + 1
             WHERE "companyId" = ${input.companyId}
               AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
               AND "sessionId" = ${ticket.sessionId}::uuid
               AND state = 'active'
               AND "providerId" = 'mistral'
               AND "providerCallId" = ${input.providerSessionId}
               AND "contextRevision" = ${ticket.contextRevision}
               AND "contextDigest" = ${cleanHash(ticket.contextDigest)}
               AND "contextAppliedRevision" = ${ticket.contextRevision}
               AND "contextAppliedDigest" = ${cleanHash(ticket.contextDigest)}
               AND "contextAppliedOwnerEpoch" = ${lease.sidebandOwnerEpoch}
               AND "sidebandOwnerEpoch" = ${lease.sidebandOwnerEpoch}
               AND "sidebandOwnerTokenHash" = ${cleanHash(artifact.sidebandOwnerTokenHash)}
               AND "sidebandOwnerLeaseExpiresAt" >= ${deliveryExpiresAt}
               AND "hardExpiresAt" >= ${deliveryExpiresAt}
               AND "leaseExpiresAt" > ${databaseNow}
          `;
          if (drained !== 1) throw new MistralIngressTransactionAbort();
        }
        const terminal = await tx.$executeRaw`
          UPDATE realtime_mistral_ingress_tickets
             SET state = 'completed', "providerTermination" = 'confirmed',
                 "finishedAt" = ${databaseNow}, version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND id = ${input.redemptionId}::uuid
             AND state = 'active'
             AND "providerSessionId" = ${input.providerSessionId}
             AND version = ${ticket.version}
        `;
        if (terminal !== 1) throw new MistralIngressTransactionAbort();
        // Après ACK/cancel, le drain peut être libéré sauf si un contrôle déjà scellé doit
        // encore être consommé. Un artefact ready reste quant à lui vivant jusqu'à ACK/expiry.
        if (artifact.state !== 'ready') {
          const preserveForControl = artifact.state === 'delivered'
            && await this.hasLiveUnconsumedControl(tx, ticket);
          const deleted = await tx.$executeRaw`
            DELETE FROM realtime_session_leases
             WHERE "companyId" = ${input.companyId}
               AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
               AND "sessionId" = ${ticket.sessionId}::uuid
               AND state = 'active'
               AND "providerId" = 'mistral'
               AND "providerCallId" = ${input.providerSessionId}
               AND "contextRevision" = ${ticket.contextRevision}
               AND "contextDigest" = ${cleanHash(ticket.contextDigest)}
               AND ${!preserveForControl}
          `;
          if (deleted !== (preserveForControl ? 0 : 1)) throw new MistralIngressTransactionAbort();
        }
        return true;
      });
      if (!completed) throw new Error('Mistral realtime ingress completion rejected.');
    } catch {
      throw new Error('Mistral realtime ingress completion unavailable.');
    }
  }

  private lockTicketById(
    tx: Prisma.TransactionClient,
    companyId: string,
    redemptionId: string,
  ): Promise<TicketRow[]> {
    return tx.$queryRaw<TicketRow[]>`
      SELECT id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", state, plan,
             "contextRevision", "contextDigest", "userIdentityCiphertext", "userIdentityNonce",
             "userIdentityTag", "identityEncryptionKeyVersion", "maxAudioBytes",
             "providerSessionId", "providerTermination", "ticketExpiresAt", "bindingExpiresAt",
             "hardExpiresAt", "consumedAt", "activatedAt", "finishedAt", version
        FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${companyId} AND id = ${redemptionId}::uuid
       FOR UPDATE
    `;
  }

  private async lockLeaseForTerminal(
    tx: Prisma.TransactionClient,
    ticket: Pick<TicketRow, 'companyId' | 'subjectHash' | 'sessionId'>,
  ): Promise<TerminalLeaseRow | null> {
    const [lease] = await tx.$queryRaw<TerminalLeaseRow[]>`
      SELECT state, "providerId", "providerCallId", "leaseExpiresAt", "hardExpiresAt",
             "contextRevision", "contextDigest", "contextAppliedRevision",
             "contextAppliedDigest", "contextAppliedOwnerEpoch", "sidebandOwnerEpoch",
             "sidebandOwnerTokenHash", "sidebandOwnerLeaseExpiresAt", "sidebandProtocolVersion"
        FROM realtime_session_leases
       WHERE "companyId" = ${ticket.companyId}
         AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
         AND "sessionId" = ${ticket.sessionId}::uuid
       FOR UPDATE
    `;
    return lease ?? null;
  }

  private lockDeliveryArtifact(
    tx: Prisma.TransactionClient,
    ticket: Pick<
    TicketRow,
      'id' | 'companyId' | 'subjectHash' | 'sessionId' | 'contextRevision' | 'contextDigest'
    >,
  ): Promise<DeliveryArtifactRow[]> {
    return tx.$queryRaw<DeliveryArtifactRow[]>`
      SELECT state, "storageExpiresAt", "contextRevision", "contextDigest",
             "sidebandOwnerEpoch", "sidebandOwnerTokenHash"
        FROM realtime_speech_artifacts
       WHERE "companyId" = ${ticket.companyId}
         AND "subjectHash" = ${cleanHash(ticket.subjectHash)}
         AND "sessionId" = ${ticket.sessionId}::uuid
         AND "turnId" = ${ticket.id}::uuid
         AND "segmentIndex" = 0
         AND "contextRevision" = ${ticket.contextRevision}
         AND "contextDigest" = ${cleanHash(ticket.contextDigest)}
         AND state IN ('ready', 'delivered', 'cancelled')
       FOR UPDATE
    `;
  }

  private async hasLiveUnconsumedControl(
    tx: Prisma.TransactionClient,
    ticket: Pick<TicketRow, 'id' | 'companyId' | 'sessionId'>,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT true AS present
        FROM realtime_control_grants AS control_grant
       WHERE control_grant."companyId" = ${ticket.companyId}
         AND control_grant."sessionId" = ${ticket.sessionId}::uuid
         AND control_grant."turnId" = ${ticket.id}::uuid
         AND control_grant."expiresAt" > clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
             FROM realtime_control_consumptions AS consumption
            WHERE consumption."companyId" = control_grant."companyId"
              AND consumption."grantId" = control_grant.id
         )
       LIMIT 1
    `;
    return row?.present === true;
  }

  private lockTenant(tx: Prisma.TransactionClient, companyId: string): Promise<number> {
    return tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`bob-live:mistral-ingress-ticket:${companyId}`}, 0
      ))
    `;
  }
}
