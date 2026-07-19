import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  isMistralConversationAdmissionOwner,
  mistralConversationProviderCallId,
  validateMistralConversationAdmissionPolicy,
  type MistralConversationAdmissionAuthority,
  type MistralConversationAdmissionOwner,
  type MistralConversationAdmissionPolicy,
  type MistralConversationAdmissionReleaseResult,
  type MistralConversationAdmissionRenewResult,
} from './mistral-conversation-admission';

interface MissionOwnerRow {
  readonly id: string;
  readonly initialBootstrapId: string;
  readonly admissionSessionId: string | null;
  readonly subjectHash: string;
  readonly sessionHandle: string;
  readonly ownerTokenHash: string;
  readonly missionConnectionEpoch: number;
  readonly phase: string;
  readonly hardExpiresAt: Date;
}

interface AdmissionRow {
  readonly state: string;
  readonly providerId: string | null;
  readonly providerCallId: string | null;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly version: number;
}

interface ClockRow {
  readonly databaseNow: Date;
}

function ownerTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function exactOwnerBinding(
  mission: MissionOwnerRow,
  input: MistralConversationAdmissionOwner,
): boolean {
  return mission.initialBootstrapId.toLowerCase() === input.bootstrapId
    && mission.admissionSessionId?.toLowerCase() === input.admissionSessionId
    && mission.subjectHash.trim() === input.subjectHash
    && mission.sessionHandle === input.sessionHandle;
}

/**
 * Lifecycle PostgreSQL de l'owner WSS v2. Il n'accepte jamais le token brut du bail générique :
 * Mission.ownerTokenHash + epoch constituent le fence unique après le bootstrap atomique.
 */
export class PrismaMistralConversationAdmissionAuthority
implements MistralConversationAdmissionAuthority {
  readonly policy: MistralConversationAdmissionPolicy;

  constructor(
    private readonly prisma: PrismaService,
    policy: MistralConversationAdmissionPolicy,
  ) {
    validateMistralConversationAdmissionPolicy(policy);
    this.policy = Object.freeze({ ...policy });
  }

  async renewOwner(
    input: MistralConversationAdmissionOwner & { readonly signal: AbortSignal },
  ): Promise<MistralConversationAdmissionRenewResult> {
    if (!isMistralConversationAdmissionOwner(input)) return { status: 'unavailable' };
    if (input.signal.aborted) return { status: 'aborted' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const locked = await this.lockOwner(tx, input);
        if (!locked) return { status: 'unavailable' as const };
        const { mission, admission, databaseNow } = locked;
        if (!exactOwnerBinding(mission, input)) return { status: 'unavailable' as const };
        if (admission === null) return { status: 'unavailable' as const };
        if (
          mission.missionConnectionEpoch !== input.missionConnectionEpoch
          || mission.ownerTokenHash.trim() !== ownerTokenHash(input.ownerLeaseToken)
        ) return { status: 'stale_owner' as const };
        if (mission.phase === 'closed') return { status: 'closed' as const };
        if (
          mission.hardExpiresAt.getTime() <= databaseNow.getTime()
          || admission.hardExpiresAt.getTime() <= databaseNow.getTime()
          || admission.leaseExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'expired' as const };
        const providerCallId = mistralConversationProviderCallId(input.bootstrapId);
        if (
          providerCallId === null
          || admission.state !== 'active'
          || admission.providerId !== 'mistral'
          || admission.providerCallId !== providerCallId
        ) return { status: 'unavailable' as const };
        if (input.signal.aborted) return { status: 'aborted' as const };
        const [renewed] = await tx.$queryRaw<Array<{ leaseExpiresAt: Date }>>`
          UPDATE realtime_session_leases
             SET "leaseExpiresAt" = LEAST(
                   ${databaseNow} + make_interval(secs => ${this.policy.activeLeaseSeconds}),
                   "hardExpiresAt"
                 ),
                 "updatedAt" = ${databaseNow},
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.admissionSessionId}::uuid
             AND state = 'active'
             AND "providerId" = 'mistral'
             AND "providerCallId" = ${providerCallId}
             AND version = ${admission.version}
             AND "leaseExpiresAt" > ${databaseNow}
             AND "hardExpiresAt" > ${databaseNow}
          RETURNING "leaseExpiresAt"
        `;
        if (!renewed) return { status: 'unavailable' as const };
        if (input.signal.aborted) return { status: 'aborted' as const };
        return {
          status: 'renewed' as const,
          leaseExpiresAt: renewed.leaseExpiresAt.toISOString(),
        };
      });
    } catch {
      return input.signal.aborted ? { status: 'aborted' } : { status: 'unavailable' };
    }
  }

  async releaseClosed(
    input: MistralConversationAdmissionOwner & { readonly signal: AbortSignal },
  ): Promise<MistralConversationAdmissionReleaseResult> {
    if (!isMistralConversationAdmissionOwner(input)) return { status: 'unavailable' };
    if (input.signal.aborted) return { status: 'aborted' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const locked = await this.lockOwner(tx, input);
        if (!locked) return { status: 'unavailable' as const };
        const { mission, admission } = locked;
        if (!exactOwnerBinding(mission, input)) return { status: 'unavailable' as const };
        if (
          mission.missionConnectionEpoch !== input.missionConnectionEpoch
          || mission.ownerTokenHash.trim() !== ownerTokenHash(input.ownerLeaseToken)
        ) return { status: 'stale_owner' as const };
        if (mission.phase !== 'closed') return { status: 'not_closed' as const };
        if (admission === null) return { status: 'replayed' as const };
        const providerCallId = mistralConversationProviderCallId(input.bootstrapId);
        if (
          providerCallId === null
          || admission.state !== 'active'
          || admission.providerId !== 'mistral'
          || admission.providerCallId !== providerCallId
        ) return { status: 'unavailable' as const };
        if (input.signal.aborted) return { status: 'aborted' as const };
        const released = await tx.$executeRaw`
          DELETE FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "sessionId" = ${input.admissionSessionId}::uuid
             AND state = 'active'
             AND "providerId" = 'mistral'
             AND "providerCallId" = ${providerCallId}
             AND version = ${admission.version}
        `;
        if (released !== 1) return { status: 'unavailable' as const };
        return { status: 'released' as const };
      });
    } catch {
      return input.signal.aborted ? { status: 'aborted' } : { status: 'unavailable' };
    }
  }

  private async lockOwner(
    tx: Prisma.TransactionClient,
    input: MistralConversationAdmissionOwner,
  ): Promise<{
    readonly mission: MissionOwnerRow;
    readonly admission: AdmissionRow | null;
    readonly databaseNow: Date;
  } | null> {
    // Ordre global après bootstrap : advisory Mission -> Mission -> admission.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${input.companyId}:${input.sessionHandle}`}, 0)
      )
    `;
    const [mission] = await tx.$queryRaw<MissionOwnerRow[]>`
      SELECT id, "initialBootstrapId", "admissionSessionId", "subjectHash", "sessionHandle",
             "ownerTokenHash", "missionConnectionEpoch", phase, "hardExpiresAt"
        FROM realtime_mistral_conversation_missions
       WHERE "companyId" = ${input.companyId}
         AND "sessionHandle" = ${input.sessionHandle}
       FOR UPDATE
    `;
    if (!mission) return null;
    const [admission] = await tx.$queryRaw<AdmissionRow[]>`
      SELECT state, "providerId", "providerCallId", "leaseExpiresAt", "hardExpiresAt", version
        FROM realtime_session_leases
       WHERE "companyId" = ${input.companyId}
         AND "subjectHash" = ${input.subjectHash}
         AND "sessionId" = ${input.admissionSessionId}::uuid
       FOR UPDATE
    `;
    const [clock] = await tx.$queryRaw<ClockRow[]>`
      SELECT clock_timestamp() AS "databaseNow"
    `;
    if (
      !(clock?.databaseNow instanceof Date)
      || Number.isNaN(clock.databaseNow.getTime())
    ) return null;
    return { mission, admission: admission ?? null, databaseNow: clock.databaseNow };
  }
}
