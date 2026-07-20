import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_PROTOCOL,
} from '@bob/ai';
import type { PlanTier } from '@bob/core';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  hashRealtimeLeaseToken,
  isRealtimeCompanyId,
  isRealtimeLeaseCredential,
  prepareRealtimeContext,
} from './realtime-admission';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_ADMISSION_POLICY,
  mistralConversationProviderCallId,
  validateMistralConversationAdmissionPolicy,
  type MistralConversationAdmissionPolicy,
} from './mistral-conversation-admission';
import {
  DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
  hashMistralConversationBootstrapTicket,
  isMistralConversationBootstrapTicket,
  secureMistralConversationBootstrapTicketEntropy,
  validateMistralConversationBootstrapTicketPolicy,
  type MistralConversationBootstrapTicketAuthority,
  type MistralConversationBootstrapTicketEntropy,
  type MistralConversationBootstrapTicketIssueInput,
  type MistralConversationBootstrapTicketIssueResult,
  type MistralConversationBootstrapTicketPolicy,
} from './mistral-conversation-bootstrap-ticket';
import type {
  MistralConversationBootstrapGrant,
  MistralConversationBootstrapOpenResult,
  MistralConversationDurableOpenResult,
} from './mistral-conversation-gateway-v2';
import { isMistralConversationInitialCommitCandidate } from './mistral-conversation-gateway-v2';
import {
  openMistralRealtimeUserIdentity,
  sealMistralRealtimeUserIdentity,
  validateMistralRealtimeIngressIdentityKeyRing,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';

const INT32_MAX = 0x7fff_ffff;
const UINT32_CURSOR_END = 0x1_0000_0000;
const PCM_BYTES_PER_QUANTUM = MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES;
const PCM_QUANTUM_MS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

interface DatabaseClockRow {
  readonly databaseNow: Date;
}

interface AdmissionLeaseRow {
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly leaseTokenHash: string;
  readonly state: string;
  readonly providerId: string | null;
  readonly providerCallId: string | null;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly contextSchemaVersion: number | null;
  readonly contextRevision: number | null;
  readonly contextPayload: unknown | null;
  readonly contextDigest: string | null;
  readonly version: number;
}

interface BootstrapQuotaRow {
  readonly tenantOutstanding: number;
  readonly subjectOutstanding: number;
  readonly tenantIssuedHour: number;
  readonly subjectIssuedHour: number;
}

interface InsertedBootstrapRow {
  readonly ticketExpiresAt: Date;
}

interface BootstrapTicketRow {
  readonly id: string;
  readonly companyId: string;
  readonly admissionSessionId: string;
  readonly sessionHandle: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly admissionLeaseTokenHash: string;
  readonly protocol: string;
  readonly state: string;
  readonly plan: string;
  readonly contextSchemaVersion: number;
  readonly contextRevision: number;
  readonly contextSnapshot: unknown;
  readonly contextDigest: string;
  readonly userIdentityCiphertext: Uint8Array;
  readonly userIdentityNonce: Uint8Array;
  readonly userIdentityTag: Uint8Array;
  readonly identityEncryptionKeyVersion: number;
  readonly routeMode: string;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
  readonly issuedAt: Date;
  readonly ticketExpiresAt: Date;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly consumedAt: Date | null;
  readonly retentionExpiresAt: Date;
  readonly version: number;
}

class BootstrapTransactionAbort extends Error {
  constructor(readonly result: MistralConversationBootstrapOpenResult) {
    super(result.status);
    this.name = 'BootstrapTransactionAbort';
  }
}

class BootstrapIssueTransactionAbort extends Error {
  constructor(readonly result: MistralConversationBootstrapTicketIssueResult) {
    super(result.status);
    this.name = 'BootstrapIssueTransactionAbort';
  }
}

function validPositiveInt(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 1
    && value <= INT32_MAX;
}

function canonicalDate(value: string): Date | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  return date.toISOString() === value ? date : null;
}

function clean(value: string): string {
  return value.trim();
}

function validIssueInput(input: MistralConversationBootstrapTicketIssueInput): boolean {
  const leaseExpiresAt = canonicalDate(input.lease.leaseExpiresAt);
  const hardExpiresAt = canonicalDate(input.lease.hardExpiresAt);
  return isRealtimeLeaseCredential(input.lease)
    && input.lease.state === 'reserved'
    && leaseExpiresAt !== null
    && hardExpiresAt !== null
    && leaseExpiresAt.getTime() <= hardExpiresAt.getTime()
    && typeof input.userId === 'string'
    && input.userId.length >= 1
    && input.userId.length <= 256
    && Buffer.byteLength(input.userId, 'utf8') <= 512
    && validPositiveInt(input.subjectKeyVersion)
    && PLANS.has(input.plan)
    && input.contextSchemaVersion === 1
    && validPositiveInt(input.contextRevision);
}

function validRedeemInput(
  input: Parameters<MistralConversationBootstrapTicketAuthority['redeemAndOpenInitial']>[0],
): boolean {
  return isRealtimeCompanyId(input.companyId)
    && isMistralConversationBootstrapTicket(input.ticket)
    && input.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && OWNER_TOKEN.test(input.ownerLeaseToken)
    && Number.isSafeInteger(input.resumeNextServerSequence)
    && input.resumeNextServerSequence >= 0
    && input.resumeNextServerSequence <= UINT32_CURSOR_END
    && Number.isSafeInteger(input.maxReplayEvents)
    && input.maxReplayEvents >= 1
    && input.maxReplayEvents <= 10_000
    && Number.isSafeInteger(input.maxReplayBytes)
    && input.maxReplayBytes >= 1
    && input.maxReplayBytes <= 64 * 1024 * 1024;
}

function contextSnapshot(
  contextRevision: number,
  context: unknown,
): { readonly version: 1; readonly revision: number; readonly context: unknown } {
  return { version: 1, revision: contextRevision, context };
}

function preparedFromStoredSnapshot(snapshot: unknown): ReturnType<typeof prepareRealtimeContext> {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || record.version !== 1
    || typeof record.revision !== 'number'
    || !Object.hasOwn(record, 'context')
  ) return null;
  return prepareRealtimeContext({
    version: record.version,
    revision: record.revision,
    context: record.context,
  });
}

function identityBinding(row: BootstrapTicketRow): MistralRealtimeIdentityBinding | null {
  if (
    !PLANS.has(row.plan as PlanTier)
    || !UUID.test(row.admissionSessionId)
    || !UUID.test(row.id)
  ) return null;
  return {
    companyId: row.companyId,
    subjectHash: clean(row.subjectHash),
    subjectKeyVersion: row.subjectKeyVersion,
    sessionId: row.admissionSessionId.toLowerCase(),
    redemptionId: row.id.toLowerCase(),
    plan: row.plan as PlanTier,
    contextRevision: row.contextRevision,
    contextDigest: clean(row.contextDigest),
  };
}

function grantFromRow(row: BootstrapTicketRow): MistralConversationBootstrapGrant | null {
  if (
    !UUID.test(row.id)
    || !UUID.test(row.admissionSessionId)
    || !isRealtimeCompanyId(row.companyId)
    || !SHA256.test(clean(row.subjectHash))
    || !validPositiveInt(row.subjectKeyVersion)
    || !PLANS.has(row.plan as PlanTier)
    || row.sessionHandle.toLowerCase() !== row.admissionSessionId.toLowerCase()
    || row.routeMode !== 'push_to_talk'
    || row.fullDuplexCertified !== false
    || !validPositiveInt(row.maxMissionAudioBytes)
    || row.maxMissionAudioBytes > MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES
    || row.maxMissionAudioBytes % PCM_BYTES_PER_QUANTUM !== 0
    || !validPositiveInt(row.contextRevision)
    || !SHA256.test(clean(row.contextDigest))
  ) return null;
  return {
    bootstrapId: row.id.toLowerCase(),
    admissionSessionId: row.admissionSessionId.toLowerCase(),
    companyId: row.companyId,
    subjectHash: clean(row.subjectHash),
    subjectKeyVersion: row.subjectKeyVersion,
    plan: row.plan as PlanTier,
    sessionHandle: row.sessionHandle.toLowerCase(),
    hardExpiresAt: row.hardExpiresAt.toISOString(),
    contextRevision: row.contextRevision,
    contextDigest: clean(row.contextDigest),
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    maxMissionAudioBytes: row.maxMissionAudioBytes,
  };
}

function mapOpenFailure(
  result: Exclude<MistralConversationDurableOpenResult, { readonly status: 'opened' }>,
): Exclude<MistralConversationBootstrapOpenResult, { readonly status: 'opened' }> {
  switch (result.status) {
    case 'expired': return { status: 'expired' };
    case 'invalid_cursor': return { status: 'invalid_cursor' };
    case 'history_unavailable': return { status: 'history_unavailable' };
    case 'unavailable': return { status: 'unavailable' };
    default: return { status: 'unavailable' };
  }
}

/**
 * Autorité PostgreSQL du bootstrap initial v2. Elle possède toujours la transaction tenant racine :
 * le CAS du ticket ne peut donc pas survivre sans Mission + outbox `session.ready`, et inversement.
 */
export class PrismaMistralConversationBootstrapTicketAuthority
implements MistralConversationBootstrapTicketAuthority {
  constructor(
    private readonly prisma: PrismaService,
    private readonly durable: PrismaMistralConversationDurableAuthority,
    private readonly identityKeys: MistralRealtimeIngressIdentityKeyRing,
    private readonly policy: MistralConversationBootstrapTicketPolicy =
    DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
    private readonly entropy: MistralConversationBootstrapTicketEntropy =
    secureMistralConversationBootstrapTicketEntropy,
    private readonly admissionPolicy: MistralConversationAdmissionPolicy =
    DEFAULT_MISTRAL_CONVERSATION_ADMISSION_POLICY,
  ) {
    validateMistralConversationBootstrapTicketPolicy(policy);
    validateMistralConversationAdmissionPolicy(admissionPolicy);
    validateMistralRealtimeIngressIdentityKeyRing(identityKeys);
  }

  async issue(
    input: MistralConversationBootstrapTicketIssueInput,
  ): Promise<MistralConversationBootstrapTicketIssueResult> {
    if (!validIssueInput(input)) return { status: 'invalid' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    const prepared = prepareRealtimeContext({
      version: input.contextSchemaVersion,
      revision: input.contextRevision,
      context: input.context,
    });
    if (!prepared) return { status: 'invalid' };
    const ticket = this.entropy.ticket();
    const ticketId = this.entropy.ticketId().toLowerCase();
    if (!isMistralConversationBootstrapTicket(ticket) || !UUID.test(ticketId)) {
      return { status: 'unavailable' };
    }
    const binding: MistralRealtimeIdentityBinding = {
      companyId: input.lease.companyId,
      subjectHash: input.lease.subjectHash,
      subjectKeyVersion: input.subjectKeyVersion,
      sessionId: input.lease.sessionId.toLowerCase(),
      redemptionId: ticketId,
      plan: input.plan,
      contextRevision: prepared.snapshot.revision,
      contextDigest: prepared.digest,
    };
    let identity: ReturnType<typeof sealMistralRealtimeUserIdentity>;
    try {
      identity = sealMistralRealtimeUserIdentity(input.userId, binding, this.identityKeys);
    } catch {
      return { status: 'invalid' };
    }

    try {
      return await this.prisma.withTenant(input.lease.companyId, async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${'mistral-conversation-bootstrap:' + input.lease.companyId}, 0)
          )
        `;
        const [clock] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!(clock?.databaseNow instanceof Date) || Number.isNaN(clock.databaseNow.getTime())) {
          return { status: 'unavailable' as const };
        }
        const databaseNow = clock.databaseNow;
        const [quota] = await tx.$queryRaw<BootstrapQuotaRow[]>`
          SELECT
            count(*) FILTER (
              WHERE state = 'issued'
                AND "ticketExpiresAt" > ${databaseNow}
                AND "hardExpiresAt" > ${databaseNow}
            )::int AS "tenantOutstanding",
            count(*) FILTER (
              WHERE "subjectHash" = ${input.lease.subjectHash}
                AND state = 'issued'
                AND "ticketExpiresAt" > ${databaseNow}
                AND "hardExpiresAt" > ${databaseNow}
            )::int AS "subjectOutstanding",
            count(*) FILTER (
              WHERE "issuedAt" > ${databaseNow} - interval '1 hour'
            )::int AS "tenantIssuedHour",
            count(*) FILTER (
              WHERE "subjectHash" = ${input.lease.subjectHash}
                AND "issuedAt" > ${databaseNow} - interval '1 hour'
            )::int AS "subjectIssuedHour"
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE "companyId" = ${input.lease.companyId}
        `;
        if (!quota) return { status: 'unavailable' as const };
        if (
          quota.tenantOutstanding >= this.policy.maxOutstandingPerTenant
          || quota.subjectOutstanding >= this.policy.maxOutstandingPerSubject
          || quota.tenantIssuedHour >= this.policy.maxIssuesPerTenantHour
          || quota.subjectIssuedHour >= this.policy.maxIssuesPerSubjectHour
        ) return { status: 'quota' as const };

        const [lease] = await tx.$queryRaw<AdmissionLeaseRow[]>`
          SELECT "subjectHash", "sessionId", "leaseTokenHash", state, "providerId",
                 "providerCallId", "leaseExpiresAt", "hardExpiresAt", "contextSchemaVersion",
                 "contextRevision", "contextPayload", "contextDigest", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.lease.companyId}
             AND "subjectHash" = ${input.lease.subjectHash}
             AND "sessionId" = ${input.lease.sessionId}::uuid
           FOR UPDATE
        `;
        const leaseTokenHash = hashRealtimeLeaseToken(input.lease.leaseToken);
        if (
          !lease
          || clean(lease.subjectHash) !== input.lease.subjectHash
          || lease.sessionId.toLowerCase() !== input.lease.sessionId.toLowerCase()
          || clean(lease.leaseTokenHash) !== leaseTokenHash
          || lease.state !== 'reserved'
          || lease.providerId !== null
          || lease.providerCallId !== null
          || lease.leaseExpiresAt.toISOString() !== input.lease.leaseExpiresAt
          || lease.hardExpiresAt.toISOString() !== input.lease.hardExpiresAt
        ) return { status: 'invalid' as const };
        if (
          lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || lease.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'expired' as const };

        const remainingQuanta = Math.floor(
          (lease.hardExpiresAt.getTime() - databaseNow.getTime()) / PCM_QUANTUM_MS,
        );
        const maxMissionAudioBytes = Math.min(
          this.policy.maxMissionAudioBytes,
          remainingQuanta * PCM_BYTES_PER_QUANTUM,
        );
        if (maxMissionAudioBytes < PCM_BYTES_PER_QUANTUM) return { status: 'expired' as const };

        const contextIsEmpty = lease.contextSchemaVersion === null
          && lease.contextRevision === null
          && lease.contextPayload === null
          && lease.contextDigest === null;
        if (!contextIsEmpty) {
          const existing = prepareRealtimeContext({
            version: lease.contextSchemaVersion ?? 0,
            revision: lease.contextRevision ?? 0,
            context: lease.contextPayload,
          });
          if (
            !existing
            || existing.snapshot.revision !== prepared.snapshot.revision
            || existing.digest !== prepared.digest
            || clean(lease.contextDigest ?? '') !== prepared.digest
          ) return { status: 'invalid' as const };
        } else {
          const contextUpdated = await tx.$executeRaw`
            UPDATE realtime_session_leases
               SET "contextSchemaVersion" = ${prepared.snapshot.version},
                   "contextRevision" = ${prepared.snapshot.revision},
                   "contextPayload" = ${prepared.serialized}::jsonb,
                   "contextDigest" = ${prepared.digest},
                   "contextUpdatedAt" = ${databaseNow},
                   "updatedAt" = ${databaseNow},
                   version = version + 1
             WHERE "companyId" = ${input.lease.companyId}
               AND "subjectHash" = ${input.lease.subjectHash}
               AND "sessionId" = ${input.lease.sessionId}::uuid
               AND "leaseTokenHash" = ${leaseTokenHash}
               AND state = 'reserved'
               AND version = ${lease.version}
               AND "contextSchemaVersion" IS NULL
               AND "contextRevision" IS NULL
               AND "contextPayload" IS NULL
               AND "contextDigest" IS NULL
          `;
          if (contextUpdated !== 1) return { status: 'unavailable' as const };
        }

        const snapshot = contextSnapshot(prepared.snapshot.revision, prepared.snapshot.context);
        const [inserted] = await tx.$queryRaw<InsertedBootstrapRow[]>`
          INSERT INTO realtime_mistral_conversation_bootstrap_tickets (
            id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
            "subjectKeyVersion", "admissionLeaseTokenHash", "ticketHash", protocol, state, plan,
            "contextSchemaVersion", "contextRevision", "contextSnapshot", "contextDigest",
            "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
            "identityEncryptionKeyVersion", "routeMode", "fullDuplexCertified",
            "maxMissionAudioBytes", "issuedAt", "ticketExpiresAt", "leaseExpiresAt",
            "hardExpiresAt", "consumedAt", "retentionExpiresAt", version, "updatedAt"
          ) VALUES (
            ${ticketId}::uuid, ${input.lease.companyId}, ${input.lease.sessionId}::uuid,
            ${input.lease.sessionId}, ${input.lease.subjectHash}, ${input.subjectKeyVersion},
            ${leaseTokenHash}, ${hashMistralConversationBootstrapTicket(ticket)},
            ${MISTRAL_CONVERSATION_PROTOCOL}, 'issued', ${input.plan},
            ${prepared.snapshot.version}, ${prepared.snapshot.revision},
            ${JSON.stringify(snapshot)}::jsonb, ${prepared.digest},
            ${Buffer.from(identity.ciphertext)}, ${Buffer.from(identity.nonce)},
            ${Buffer.from(identity.tag)}, ${identity.keyVersion}, 'push_to_talk', false,
            ${maxMissionAudioBytes}, ${databaseNow},
            LEAST(
              ${databaseNow} + make_interval(secs => ${this.policy.ticketTtlSeconds}),
              ${lease.leaseExpiresAt}, ${lease.hardExpiresAt}
            ),
            ${lease.leaseExpiresAt}, ${lease.hardExpiresAt}, NULL,
            ${lease.hardExpiresAt} + make_interval(secs => ${this.policy.retentionSeconds}), 1,
            ${databaseNow}
          )
          RETURNING "ticketExpiresAt"
        `;
        if (!inserted) throw new BootstrapIssueTransactionAbort({ status: 'unavailable' });
        return {
          status: 'issued' as const,
          bootstrap: {
            companyId: input.lease.companyId,
            sessionHandle: input.lease.sessionId.toLowerCase(),
            ticket,
            protocol: MISTRAL_CONVERSATION_PROTOCOL,
            ticketExpiresAt: inserted.ticketExpiresAt.toISOString(),
            hardExpiresAt: lease.hardExpiresAt.toISOString(),
            contextRevision: prepared.snapshot.revision,
            contextDigest: prepared.digest,
            routeMode: 'push_to_talk' as const,
            fullDuplexCertified: false as const,
            maxMissionAudioBytes,
          },
        };
      });
    } catch (error) {
      if (error instanceof BootstrapIssueTransactionAbort) return error.result;
      return { status: 'unavailable' };
    }
  }

  async redeemAndOpenInitial(
    input: Parameters<MistralConversationBootstrapTicketAuthority['redeemAndOpenInitial']>[0],
  ): Promise<MistralConversationBootstrapOpenResult> {
    if (!validRedeemInput(input)) return { status: 'invalid' };
    if (input.resumeNextServerSequence !== 0) return { status: 'invalid_cursor' };
    if (input.signal.aborted) return { status: 'aborted' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    const ticketHash = hashMistralConversationBootstrapTicket(input.ticket);
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        // Ordre global obligatoire : ticket -> bail d'admission -> clé de mission.
        const [row] = await tx.$queryRaw<BootstrapTicketRow[]>`
          SELECT id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
                 "subjectKeyVersion", "admissionLeaseTokenHash", protocol, state, plan,
                 "contextSchemaVersion", "contextRevision", "contextSnapshot", "contextDigest",
                 "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
                 "identityEncryptionKeyVersion", "routeMode", "fullDuplexCertified",
                 "maxMissionAudioBytes", "issuedAt", "ticketExpiresAt", "leaseExpiresAt",
                 "hardExpiresAt", "consumedAt", "retentionExpiresAt", version
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE "companyId" = ${input.companyId}
             AND "ticketHash" = ${ticketHash}
             AND protocol = ${MISTRAL_CONVERSATION_PROTOCOL}
           FOR UPDATE
        `;
        if (!row) return { status: 'invalid' as const };
        if (row.state === 'consumed') return { status: 'replayed' as const };
        if (row.state !== 'issued' || row.consumedAt !== null) {
          return { status: 'unavailable' as const };
        }
        const [lease] = await tx.$queryRaw<AdmissionLeaseRow[]>`
          SELECT "subjectHash", "sessionId", "leaseTokenHash", state, "providerId",
                 "providerCallId", "leaseExpiresAt", "hardExpiresAt", "contextSchemaVersion",
                 "contextRevision", "contextPayload", "contextDigest", version
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${clean(row.subjectHash)}
             AND "sessionId" = ${row.admissionSessionId}::uuid
           FOR UPDATE
        `;
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${input.companyId}:${row.sessionHandle}`}, 0)
          )
        `;
        const [clock] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!(clock?.databaseNow instanceof Date) || Number.isNaN(clock.databaseNow.getTime())) {
          throw new BootstrapTransactionAbort({ status: 'unavailable' });
        }
        if (input.signal.aborted) throw new BootstrapTransactionAbort({ status: 'aborted' });
        const databaseNow = clock.databaseNow;
        if (
          row.ticketExpiresAt.getTime() <= databaseNow.getTime()
          || row.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || row.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'expired' as const };

        const storedContext = preparedFromStoredSnapshot(row.contextSnapshot);
        const admissionContext = lease && prepareRealtimeContext({
          version: lease.contextSchemaVersion ?? 0,
          revision: lease.contextRevision ?? 0,
          context: lease.contextPayload,
        });
        const binding = identityBinding(row);
        const grant = grantFromRow(row);
        if (
          !lease
          || !storedContext
          || !admissionContext
          || !binding
          || !grant
          || row.companyId !== input.companyId
          || row.protocol !== MISTRAL_CONVERSATION_PROTOCOL
          || row.contextSchemaVersion !== 1
          || storedContext.snapshot.revision !== row.contextRevision
          || storedContext.digest !== clean(row.contextDigest)
          || admissionContext.snapshot.revision !== row.contextRevision
          || admissionContext.digest !== clean(row.contextDigest)
          || clean(lease.contextDigest ?? '') !== clean(row.contextDigest)
          || clean(lease.subjectHash) !== clean(row.subjectHash)
          || lease.sessionId.toLowerCase() !== row.admissionSessionId.toLowerCase()
          || clean(lease.leaseTokenHash) !== clean(row.admissionLeaseTokenHash)
          || lease.state !== 'reserved'
          || lease.providerId !== null
          || lease.providerCallId !== null
          || lease.leaseExpiresAt.getTime() !== row.leaseExpiresAt.getTime()
          || lease.hardExpiresAt.getTime() !== row.hardExpiresAt.getTime()
          || lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || lease.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        if (openMistralRealtimeUserIdentity({
          ciphertext: Uint8Array.from(row.userIdentityCiphertext),
          nonce: Uint8Array.from(row.userIdentityNonce),
          tag: Uint8Array.from(row.userIdentityTag),
          keyVersion: row.identityEncryptionKeyVersion,
        }, binding, this.identityKeys) === null) {
          throw new BootstrapTransactionAbort({ status: 'unavailable' });
        }

        const opened = await this.durable.openWithinTransaction(tx, {
          grant,
          ownerLeaseToken: input.ownerLeaseToken,
          resumeNextServerSequence: input.resumeNextServerSequence,
          maxReplayEvents: input.maxReplayEvents,
          maxReplayBytes: input.maxReplayBytes,
          signal: input.signal,
        });
        if (input.signal.aborted) throw new BootstrapTransactionAbort({ status: 'aborted' });
        if (opened.status !== 'opened') {
          throw new BootstrapTransactionAbort(mapOpenFailure(opened));
        }
        // L'ouverture durable peut traverser la courte fenêtre du ticket. Une seconde lecture BDD
        // est obligatoire avant le CAS afin que Mission + outbox soient rollbackés à la frontière.
        const [commitClock] = await tx.$queryRaw<DatabaseClockRow[]>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (
          !(commitClock?.databaseNow instanceof Date)
          || Number.isNaN(commitClock.databaseNow.getTime())
        ) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        const commitNow = commitClock.databaseNow;
        if (
          row.ticketExpiresAt.getTime() <= commitNow.getTime()
          || row.leaseExpiresAt.getTime() <= commitNow.getTime()
          || row.hardExpiresAt.getTime() <= commitNow.getTime()
        ) throw new BootstrapTransactionAbort({ status: 'expired' });
        if (!isMistralConversationInitialCommitCandidate({
          opened,
          grant,
          companyId: input.companyId,
          resumeNextServerSequence: input.resumeNextServerSequence,
          databaseNow: commitNow.getTime(),
        })) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        const providerCallId = mistralConversationProviderCallId(row.id);
        if (providerCallId === null) {
          throw new BootstrapTransactionAbort({ status: 'unavailable' });
        }
        const bound = await tx.$executeRaw`
          UPDATE realtime_session_leases
             SET state = 'bound',
                 "providerId" = 'mistral',
                 "providerCallId" = ${providerCallId},
                 "updatedAt" = ${commitNow},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${clean(row.subjectHash)}
             AND "sessionId" = ${row.admissionSessionId}::uuid
             AND "leaseTokenHash" = ${clean(row.admissionLeaseTokenHash)}
             AND state = 'reserved'
             AND "providerId" IS NULL
             AND "providerCallId" IS NULL
             AND version = ${lease.version}
             AND "leaseExpiresAt" > ${commitNow}
             AND "hardExpiresAt" > ${commitNow}
        `;
        if (bound !== 1) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        const activated = await tx.$executeRaw`
          UPDATE realtime_session_leases
             SET state = 'active',
                 "activatedAt" = ${commitNow},
                 "leaseExpiresAt" = LEAST(
                   ${commitNow} + make_interval(secs => ${this.admissionPolicy.activeLeaseSeconds}),
                   "hardExpiresAt"
                 ),
                 "updatedAt" = ${commitNow},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${clean(row.subjectHash)}
             AND "sessionId" = ${row.admissionSessionId}::uuid
             AND "leaseTokenHash" = ${clean(row.admissionLeaseTokenHash)}
             AND state = 'bound'
             AND "providerId" = 'mistral'
             AND "providerCallId" = ${providerCallId}
             AND version = ${lease.version + 1}
             AND "leaseExpiresAt" > ${commitNow}
             AND "hardExpiresAt" > ${commitNow}
        `;
        if (activated !== 1) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        const consumed = await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_bootstrap_tickets
             SET state = 'consumed',
                 "consumedAt" = ${commitNow},
                 "updatedAt" = ${commitNow},
                 version = version + 1
           WHERE id = ${row.id}::uuid
             AND "companyId" = ${input.companyId}
             AND state = 'issued'
             AND "consumedAt" IS NULL
             AND version = ${row.version}
             AND "ticketExpiresAt" > ${commitNow}
             AND "leaseExpiresAt" > ${commitNow}
             AND "hardExpiresAt" > ${commitNow}
        `;
        if (consumed !== 1) throw new BootstrapTransactionAbort({ status: 'unavailable' });
        if (input.signal.aborted) throw new BootstrapTransactionAbort({ status: 'aborted' });
        return { ...opened, grant };
      });
    } catch (error) {
      if (error instanceof BootstrapTransactionAbort) return error.result;
      return input.signal.aborted ? { status: 'aborted' } : { status: 'unavailable' };
    }
  }
}
