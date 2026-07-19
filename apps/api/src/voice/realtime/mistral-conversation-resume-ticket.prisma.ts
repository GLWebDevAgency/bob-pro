import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import type { PlanTier } from '@bob/core';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import {
  hashMistralConversationBootstrapTicket,
  isMistralConversationBootstrapTicket,
} from './mistral-conversation-bootstrap-ticket';
import {
  openMistralRealtimeUserIdentity,
  validateMistralRealtimeIngressIdentityKeyRing,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';
import {
  validateMistralConversationPersistenceKeyRing,
  type MistralConversationPersistenceKeyRing,
} from './mistral-conversation-outbox-seal';
import type { MistralConversationBootstrapGrant } from './mistral-conversation-gateway-v2';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
  MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS,
  hashMistralConversationResumeTicket,
  isMistralConversationConnectionLeaseToken,
  isMistralConversationReplayConnectionId,
  isMistralConversationResumeIssueInput,
  isMistralConversationResumeTicket,
  isMistralConversationTerminalReceipt,
  secureMistralConversationResumeTicketEntropy,
  validateMistralConversationResumeTicketPolicy,
  type MistralConversationRedeemAndOpenResult,
  type MistralConversationBootstrapReconciliationResult,
  type MistralConversationResumeAuthority,
  type MistralConversationResumeScope,
  type MistralConversationResumeTicketEntropy,
  type MistralConversationResumeTicketIssueInput,
  type MistralConversationResumeTicketIssueResult,
  type MistralConversationResumeTicketPolicy,
  type MistralConversationTerminalAcknowledgementResult,
  type MistralConversationTerminalReceipt,
} from './mistral-conversation-resume-ticket';
import {
  areMistralConversationBootstrapReconciliationTicketHashesEqual,
  deriveMistralConversationBootstrapReconciliationCapability,
  isMistralConversationBootstrapReconciliationAttempt,
} from './mistral-conversation-bootstrap-reconciliation';

const INT32_MAX = 0x7fff_ffff;
const UINT32_CURSOR_END = 0x1_0000_0000;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SUBJECT_HASH = /^[a-f0-9]{64}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

const TERMINAL_CONNECTION_HASH_DOMAIN = 'bob-pro:mistral-v2-terminal-ack:v1\0';

interface MissionRow {
  readonly id: string;
  readonly companyId: string;
  readonly initialBootstrapId: string;
  readonly admissionSessionId: string | null;
  readonly protocol: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: string;
  readonly sessionHandle: string;
  readonly missionConnectionEpoch: number;
  readonly version: bigint;
  readonly acknowledgedServerSequence: bigint;
  readonly retainedFromServerSequence: bigint;
  readonly nextServerSequence: bigint;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly routeMode: string;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
  readonly phase: string;
  readonly terminalReason: string | null;
  readonly closedAt: Date | null;
  readonly hardExpiresAt: Date;
  readonly replayGraceExpiresAt: Date;
  readonly retentionExpiresAt: Date;
}

interface TerminalReceiptRow {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly protocol: string;
  readonly missionConnectionEpoch: number;
  readonly nextServerSequence: bigint;
  readonly terminalReason: string;
  readonly closedAt: Date;
}

interface ResumeTicketRow {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string;
  readonly sessionHandle: string;
  readonly admissionSessionId: string;
  readonly ticketHash: string;
  readonly protocol: string;
  readonly scope: MistralConversationResumeScope;
  readonly state: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: string;
  readonly expectedMissionConnectionEpoch: number;
  readonly clientAcceptedMissionConnectionEpoch: number;
  readonly resumeNextServerSequence: bigint;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly routeMode: string;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
  readonly hardExpiresAt: Date;
  readonly replayGraceExpiresAt: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly consumedMissionConnectionEpoch: number | null;
  readonly replayConnectionId: string | null;
  readonly connectionLeaseExpiresAt: Date | null;
  readonly maxAcknowledgableServerSequence: bigint | null;
  readonly retentionExpiresAt: Date;
  readonly version: number;
  readonly purpose: 'standard_resume' | 'initial_bootstrap_reconciliation';
  readonly initialBootstrapId: string | null;
  readonly reconciliationAttempt: number | null;
  readonly reconciliationKeyVersion: number | null;
}

interface BootstrapReconciliationRow {
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
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly userIdentityCiphertext: Uint8Array;
  readonly userIdentityNonce: Uint8Array;
  readonly userIdentityTag: Uint8Array;
  readonly identityEncryptionKeyVersion: number;
  readonly routeMode: string;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
  readonly ticketExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly consumedAt: Date | null;
  readonly retentionExpiresAt: Date;
}

interface TerminalCapabilityRow extends ResumeTicketRow {
  readonly connectionLeaseTokenHash: string | null;
}

interface ResumeTicketPurposeRow {
  readonly purpose: 'standard_resume' | 'initial_bootstrap_reconciliation';
  readonly initialBootstrapId: string | null;
}

interface AdmissionLeaseRow {
  readonly state: string;
  readonly providerId: string | null;
  readonly providerCallId: string | null;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
}

interface ResumeAuthorityOptions {
  readonly policy?: MistralConversationResumeTicketPolicy;
  readonly entropy?: MistralConversationResumeTicketEntropy;
  /** Failpoint déterministe : toute erreur doit rollback mission, outbox et ticket ensemble. */
  readonly beforeTicketConsume?: () => void | Promise<void>;
  /** Requis avec identityKeys pour réparer uniquement les commits initiaux tardifs. */
  readonly reconciliationKeys?: MistralConversationPersistenceKeyRing;
  readonly reconciliationIdentityKeys?: MistralRealtimeIngressIdentityKeyRing;
}

class ResumeAtomicAbort extends Error {
  constructor() {
    super('Mistral conversation resume atomic commit aborted.');
    this.name = 'ResumeAtomicAbort';
  }
}

class ResumeExpiredAbort extends Error {
  constructor() {
    super('Mistral conversation terminal capability window expired.');
    this.name = 'ResumeExpiredAbort';
  }
}

function domainHash(domain: string, secret: string): string {
  return createHash('sha256').update(domain, 'utf8').update(secret, 'utf8').digest('hex');
}

function terminalConnectionHash(token: string): string {
  return domainHash(TERMINAL_CONNECTION_HASH_DOMAIN, token);
}

function safeNumber(value: bigint): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function validRedeemInput(
  input: Parameters<MistralConversationResumeAuthority['redeemAndOpen']>[0],
): boolean {
  return COMPANY_ID.test(input.companyId)
    && isMistralConversationResumeTicket(input.ticket)
    && input.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && (input.expectedScope === 'live_takeover' || input.expectedScope === 'terminal_replay')
    && isIntegerBetween(input.resumeNextServerSequence, 0, UINT32_CURSOR_END)
    && isIntegerBetween(input.maxReplayEvents, 1, MAX_REPLAY_EVENTS)
    && isIntegerBetween(input.maxReplayBytes, 1, MAX_REPLAY_BYTES);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function validBootstrapReconciliationInput(
  input: Parameters<MistralConversationResumeAuthority['reconcileInitialBootstrap']>[0],
): boolean {
  return COMPANY_ID.test(input.companyId)
    && typeof input.userId === 'string'
    && input.userId.length >= 1
    && input.userId.length <= 256
    && Buffer.byteLength(input.userId, 'utf8') <= 512
    && !containsAsciiControlCharacter(input.userId)
    && SESSION_HANDLE.test(input.sessionHandle)
    && input.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && isMistralConversationBootstrapTicket(input.bootstrapTicket)
    && isMistralConversationBootstrapReconciliationAttempt(input.attempt);
}

function validTerminalAcknowledgementInput(
  input: Parameters<MistralConversationResumeAuthority['acknowledgeTerminal']>[0],
): boolean {
  return COMPANY_ID.test(input.companyId)
    && SUBJECT_HASH.test(input.subjectHash)
    && SESSION_HANDLE.test(input.sessionHandle)
    && isIntegerBetween(input.missionConnectionEpoch, 1, INT32_MAX)
    && isMistralConversationReplayConnectionId(input.replayConnectionId)
    && isMistralConversationConnectionLeaseToken(input.connectionLeaseToken)
    && isIntegerBetween(input.nextServerSequence, 0, UINT32_CURSOR_END);
}

function exactMissionBinding(ticket: ResumeTicketRow, mission: MissionRow): boolean {
  return mission.id === ticket.missionId
    && mission.companyId === ticket.companyId
    && mission.sessionHandle === ticket.sessionHandle
    && mission.admissionSessionId === ticket.admissionSessionId
    && mission.protocol === ticket.protocol
    && mission.subjectHash.trim() === ticket.subjectHash.trim()
    && mission.subjectKeyVersion === ticket.subjectKeyVersion
    && mission.plan === ticket.plan
    && mission.contextRevision === ticket.contextRevision
    && mission.contextDigest.trim() === ticket.contextDigest.trim()
    && mission.routeMode === ticket.routeMode
    && mission.fullDuplexCertified === ticket.fullDuplexCertified
    && mission.maxMissionAudioBytes === ticket.maxMissionAudioBytes
    && mission.hardExpiresAt.getTime() === ticket.hardExpiresAt.getTime()
    && mission.replayGraceExpiresAt.getTime() === ticket.replayGraceExpiresAt.getTime()
    && mission.retentionExpiresAt.getTime() === ticket.retentionExpiresAt.getTime();
}

function terminalReceiptFromRow(
  row: TerminalReceiptRow,
): MistralConversationTerminalReceipt | null {
  const nextServerSequence = safeNumber(row.nextServerSequence);
  if (
    nextServerSequence === null
    || !(row.closedAt instanceof Date)
    || Number.isNaN(row.closedAt.getTime())
  ) return null;
  const receipt: MistralConversationTerminalReceipt = {
    companyId: row.companyId,
    sessionHandle: row.sessionHandle,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    missionConnectionEpoch: row.missionConnectionEpoch,
    nextServerSequence,
    reason: row.terminalReason as MistralConversationTerminalReceipt['reason'],
    closedAt: row.closedAt.toISOString(),
  };
  return row.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && isMistralConversationTerminalReceipt(receipt)
    ? Object.freeze(receipt)
    : null;
}

function exactTerminalReceiptMissionBinding(
  receipt: TerminalReceiptRow,
  mission: MissionRow,
): boolean {
  return mission.phase === 'closed'
    && mission.terminalReason !== null
    && mission.closedAt instanceof Date
    && receipt.companyId === mission.companyId
    && receipt.sessionHandle === mission.sessionHandle
    && receipt.subjectHash.trim() === mission.subjectHash.trim()
    && receipt.subjectKeyVersion === mission.subjectKeyVersion
    && receipt.protocol === mission.protocol
    && receipt.missionConnectionEpoch === mission.missionConnectionEpoch
    && receipt.nextServerSequence === mission.nextServerSequence
    && receipt.terminalReason === mission.terminalReason
    && receipt.closedAt.getTime() === mission.closedAt.getTime();
}

function inputOwnsSubject(
  input: MistralConversationResumeTicketIssueInput,
  subjectHash: string,
  subjectKeyVersion: number,
): boolean {
  const normalizedHash = subjectHash.trim();
  return (
    normalizedHash === input.subjectHash
    && subjectKeyVersion === input.subjectKeyVersion
  ) || (input.historicalSubjectBindings ?? []).some((binding) => (
    normalizedHash === binding.subjectHash
    && subjectKeyVersion === binding.subjectKeyVersion
  ));
}

function terminalReceiptIssueResult(
  row: TerminalReceiptRow,
  input: MistralConversationResumeTicketIssueInput,
): MistralConversationResumeTicketIssueResult {
  const receipt = terminalReceiptFromRow(row);
  if (receipt === null) return { status: 'unavailable' };
  if (!inputOwnsSubject(input, row.subjectHash, row.subjectKeyVersion)) {
    return { status: 'forbidden' };
  }
  if (input.clientAcceptedMissionConnectionEpoch > receipt.missionConnectionEpoch) {
    return { status: 'stale_epoch' };
  }
  if (input.resumeNextServerSequence > receipt.nextServerSequence) {
    return { status: 'invalid_cursor' };
  }
  if (
    receipt.missionConnectionEpoch > input.clientAcceptedMissionConnectionEpoch
    && receipt.nextServerSequence <= input.resumeNextServerSequence
  ) return { status: 'unavailable' };
  return { status: 'terminal_complete', receipt };
}

function exactResumePurposeBinding(ticket: ResumeTicketRow, mission: MissionRow): boolean {
  if (ticket.purpose === 'standard_resume') {
    return ticket.initialBootstrapId === null
      && ticket.reconciliationAttempt === null
      && ticket.reconciliationKeyVersion === null
      && ticket.clientAcceptedMissionConnectionEpoch >= 1;
  }
  return ticket.purpose === 'initial_bootstrap_reconciliation'
    && ticket.initialBootstrapId === mission.initialBootstrapId
    && ticket.reconciliationAttempt !== null
    && isMistralConversationBootstrapReconciliationAttempt(ticket.reconciliationAttempt)
    && ticket.reconciliationKeyVersion !== null
    && isIntegerBetween(ticket.reconciliationKeyVersion, 1, INT32_MAX)
    && ticket.clientAcceptedMissionConnectionEpoch === 0
    && ticket.resumeNextServerSequence === 0n;
}

function exactBootstrapMissionBinding(
  bootstrap: BootstrapReconciliationRow,
  mission: MissionRow,
): boolean {
  return mission.initialBootstrapId === bootstrap.id
    && mission.companyId === bootstrap.companyId
    && mission.admissionSessionId === bootstrap.admissionSessionId
    && mission.sessionHandle === bootstrap.sessionHandle
    && mission.protocol === bootstrap.protocol
    && mission.subjectHash.trim() === bootstrap.subjectHash.trim()
    && mission.subjectKeyVersion === bootstrap.subjectKeyVersion
    && mission.plan === bootstrap.plan
    && mission.contextRevision === bootstrap.contextRevision
    && mission.contextDigest.trim() === bootstrap.contextDigest.trim()
    && mission.routeMode === bootstrap.routeMode
    && mission.fullDuplexCertified === bootstrap.fullDuplexCertified
    && mission.maxMissionAudioBytes === bootstrap.maxMissionAudioBytes
    && mission.hardExpiresAt.getTime() === bootstrap.hardExpiresAt.getTime()
    // Les deux autorités utilisent aujourd'hui la même fenêtre H→G (24 h). Une divergence de
    // politique doit échouer fermée avant l'INSERT, puis être arbitrée explicitement.
    && mission.retentionExpiresAt.getTime() === bootstrap.retentionExpiresAt.getTime();
}

function bootstrapIdentityBinding(
  bootstrap: BootstrapReconciliationRow,
): MistralRealtimeIdentityBinding | null {
  if (
    !UUID.test(bootstrap.id)
    || !UUID.test(bootstrap.admissionSessionId)
    || !PLANS.has(bootstrap.plan as PlanTier)
    || !SUBJECT_HASH.test(bootstrap.subjectHash.trim())
    || !isIntegerBetween(bootstrap.subjectKeyVersion, 1, INT32_MAX)
    || !isIntegerBetween(bootstrap.contextRevision, 1, INT32_MAX)
    || !SUBJECT_HASH.test(bootstrap.contextDigest.trim())
  ) return null;
  return {
    companyId: bootstrap.companyId,
    subjectHash: bootstrap.subjectHash.trim(),
    subjectKeyVersion: bootstrap.subjectKeyVersion,
    sessionId: bootstrap.admissionSessionId.toLowerCase(),
    redemptionId: bootstrap.id.toLowerCase(),
    plan: bootstrap.plan as PlanTier,
    contextRevision: bootstrap.contextRevision,
    contextDigest: bootstrap.contextDigest.trim(),
  };
}

function grantFromMission(mission: MissionRow): MistralConversationBootstrapGrant | null {
  if (
    mission.admissionSessionId === null
    || !UUID.test(mission.initialBootstrapId)
    || !UUID.test(mission.admissionSessionId)
    || mission.protocol !== MISTRAL_CONVERSATION_PROTOCOL
    || !SUBJECT_HASH.test(mission.subjectHash.trim())
    || !SESSION_HANDLE.test(mission.sessionHandle)
    || (mission.plan !== 'free'
      && mission.plan !== 'solo'
      && mission.plan !== 'pro'
      && mission.plan !== 'business')
    || (mission.routeMode !== 'push_to_talk' && mission.routeMode !== 'full_duplex')
  ) return null;
  return {
    bootstrapId: mission.initialBootstrapId,
    admissionSessionId: mission.admissionSessionId,
    companyId: mission.companyId,
    subjectHash: mission.subjectHash.trim(),
    subjectKeyVersion: mission.subjectKeyVersion,
    plan: mission.plan,
    sessionHandle: mission.sessionHandle,
    hardExpiresAt: mission.hardExpiresAt.toISOString(),
    contextRevision: mission.contextRevision,
    contextDigest: mission.contextDigest.trim(),
    routeMode: mission.routeMode,
    fullDuplexCertified: mission.fullDuplexCertified,
    maxMissionAudioBytes: mission.maxMissionAudioBytes,
  };
}

/**
 * Autorité PostgreSQL des capacités de reprise v2. La reprise live générale reste désactivée.
 * Seule une capacité portant la preuve `initial_bootstrap_reconciliation` peut récupérer un
 * commit initial dont la réponse WSS a été perdue ; elle conserve les mêmes fences lease/reaper.
 */
export class PrismaMistralConversationResumeAuthority
implements MistralConversationResumeAuthority {
  private readonly policy: MistralConversationResumeTicketPolicy;
  private readonly entropy: MistralConversationResumeTicketEntropy;
  private readonly beforeTicketConsume: () => void | Promise<void>;
  private readonly reconciliationKeys: MistralConversationPersistenceKeyRing | null;
  private readonly reconciliationIdentityKeys: MistralRealtimeIngressIdentityKeyRing | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly durable: PrismaMistralConversationDurableAuthority,
    options: ResumeAuthorityOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY;
    validateMistralConversationResumeTicketPolicy(this.policy);
    this.entropy = options.entropy ?? secureMistralConversationResumeTicketEntropy;
    this.beforeTicketConsume = options.beforeTicketConsume ?? (() => undefined);
    const reconciliationConfigured = options.reconciliationKeys !== undefined
      || options.reconciliationIdentityKeys !== undefined;
    if (
      reconciliationConfigured
      && (!options.reconciliationKeys || !options.reconciliationIdentityKeys)
    ) throw new Error('Incomplete Mistral bootstrap reconciliation keyrings.');
    if (options.reconciliationKeys && options.reconciliationIdentityKeys) {
      validateMistralConversationPersistenceKeyRing(options.reconciliationKeys);
      validateMistralRealtimeIngressIdentityKeyRing(options.reconciliationIdentityKeys);
    }
    this.reconciliationKeys = options.reconciliationKeys ?? null;
    this.reconciliationIdentityKeys = options.reconciliationIdentityKeys ?? null;
  }

  async issue(
    input: MistralConversationResumeTicketIssueInput,
  ): Promise<MistralConversationResumeTicketIssueResult> {
    if (!isMistralConversationResumeIssueInput(input) || input.signal.aborted) {
      return { status: 'invalid' };
    }
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockMissionKey(tx, input.companyId, input.sessionHandle);
        const mission = await this.lockMission(tx, input.companyId, input.sessionHandle);
        if (!mission) {
          const receipt = await this.inspectTerminalReceipt(
            tx,
            input.companyId,
            input.sessionHandle,
          );
          return receipt === null
            ? { status: 'not_found' as const }
            : terminalReceiptIssueResult(receipt, input);
        }
        let databaseNow = await this.databaseNow(tx);
        if (
          mission.admissionSessionId === null
          || !inputOwnsSubject(
            input,
            mission.subjectHash,
            mission.subjectKeyVersion,
          )
        ) return { status: 'forbidden' as const };
        if (input.clientAcceptedMissionConnectionEpoch > mission.missionConnectionEpoch) {
          return { status: 'stale_epoch' as const };
        }
        const nextServerSequence = safeNumber(mission.nextServerSequence);
        const acknowledgedServerSequence = safeNumber(mission.acknowledgedServerSequence);
        const retainedFromServerSequence = safeNumber(mission.retainedFromServerSequence);
        if (
          nextServerSequence === null
          || acknowledgedServerSequence === null
          || retainedFromServerSequence === null
        ) return { status: 'unavailable' as const };
        if (input.resumeNextServerSequence > nextServerSequence) {
          return { status: 'invalid_cursor' as const };
        }
        // Seul le reçu immuable créé avec la fermeture BDD autorise la convergence mobile. Tant
        // que le replay reste possible, un client en retard le consomme encore normalement. Une
        // fois G dépassé, le reçu devient l'unique projection non sensible conservée après purge.
        if (
          mission.phase === 'closed'
          && (
            (
              input.resumeNextServerSequence === nextServerSequence
              && acknowledgedServerSequence === nextServerSequence
            )
            || mission.replayGraceExpiresAt.getTime() <= databaseNow.getTime()
          )
        ) {
          const receipt = await this.inspectTerminalReceipt(
            tx,
            input.companyId,
            input.sessionHandle,
          );
          if (receipt === null || !exactTerminalReceiptMissionBinding(receipt, mission)) {
            return { status: 'unavailable' as const };
          }
          return terminalReceiptIssueResult(receipt, input);
        }
        if (mission.replayGraceExpiresAt.getTime() <= databaseNow.getTime()) {
          return { status: 'expired' as const };
        }
        const replayFrom = Math.min(
          input.resumeNextServerSequence,
          acknowledgedServerSequence,
        );
        if (replayFrom < retainedFromServerSequence) {
          return { status: 'history_unavailable' as const };
        }

        let terminalWindow = mission.phase === 'draining'
          || mission.phase === 'closed'
          || databaseNow.getTime() >= mission.hardExpiresAt.getTime();
        let admission: AdmissionLeaseRow | null = null;
        if (!terminalWindow) {
          // Une recovery déjà durable exige un suffixe transport canonique qui n'est pas
          // encore certifié. Aucun ticket live n'est émis pour cet état intermédiaire.
          if (mission.phase === 'recovering_route') return { status: 'unavailable' as const };
          // Le verdict live n'utilise jamais l'horloge lue avant le verrou de lease. On relit
          // clock_timestamp() après mission -> admission, puis on requalifie H exactement.
          admission = await this.lockAdmission(tx, mission);
          databaseNow = await this.databaseNow(tx);
          terminalWindow = mission.phase === 'draining'
            || mission.phase === 'closed'
            || databaseNow.getTime() >= mission.hardExpiresAt.getTime();
        }
        const scope: MistralConversationResumeScope = terminalWindow
          ? 'terminal_replay'
          : 'live_takeover';
        if (scope === 'live_takeover') {
          if (!this.policy.liveTakeoverEnabled) return { status: 'unavailable' as const };
          if (mission.missionConnectionEpoch >= INT32_MAX) return { status: 'expired' as const };
          if (!this.admissionIsLive(admission, databaseNow)) {
            return { status: 'unavailable' as const };
          }
        }

        const [quota] = await tx.$queryRaw<Array<{ outstanding: number }>>`
          SELECT count(*)::int AS outstanding
            FROM realtime_mistral_conversation_resume_tickets
           WHERE "companyId" = ${mission.companyId}
             AND "subjectHash" = ${input.subjectHash}
             AND "missionId" = ${mission.id}::uuid
             AND state = 'issued'
             AND "expiresAt" > ${databaseNow}
        `;
        if (
          !Number.isSafeInteger(quota?.outstanding)
          || (quota?.outstanding ?? Number.POSITIVE_INFINITY)
            >= this.policy.maxOutstandingTicketsPerMission
        ) return { status: 'unavailable' as const };

        const absoluteBoundary = scope === 'live_takeover'
          ? mission.hardExpiresAt
          : mission.replayGraceExpiresAt;
        if (
          scope === 'terminal_replay'
          && absoluteBoundary.getTime() - databaseNow.getTime()
            < MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS
        ) return { status: 'expired' as const };
        const expiresAt = new Date(Math.min(
          databaseNow.getTime() + this.policy.ticketTtlSeconds * 1_000,
          absoluteBoundary.getTime(),
        ));
        if (expiresAt.getTime() <= databaseNow.getTime()) return { status: 'expired' as const };
        const id = this.entropy.ticketId().toLowerCase();
        const ticket = this.entropy.ticket();
        if (!UUID.test(id) || !isMistralConversationResumeTicket(ticket)) {
          return { status: 'unavailable' as const };
        }
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        const inserted = await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_resume_tickets (
            id, "companyId", "missionId", "sessionHandle", "admissionSessionId",
            "ticketHash", protocol, scope, state, "subjectHash", "subjectKeyVersion", plan,
            "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
            "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
            "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
            "replayGraceExpiresAt", "issuedAt", "expiresAt", "retentionExpiresAt", version
          ) VALUES (
            ${id}::uuid, ${mission.companyId}, ${mission.id}::uuid, ${mission.sessionHandle},
            ${mission.admissionSessionId}::uuid, ${hashMistralConversationResumeTicket(ticket)}, ${MISTRAL_CONVERSATION_PROTOCOL},
            ${scope}, 'issued', ${mission.subjectHash.trim()}, ${mission.subjectKeyVersion},
            ${mission.plan}, ${mission.missionConnectionEpoch},
            ${input.clientAcceptedMissionConnectionEpoch}, ${BigInt(input.resumeNextServerSequence)},
            ${mission.contextRevision}, ${mission.contextDigest.trim()}, ${mission.routeMode},
            ${mission.fullDuplexCertified}, ${mission.maxMissionAudioBytes},
            ${mission.hardExpiresAt}, ${mission.replayGraceExpiresAt}, ${databaseNow}, ${expiresAt},
            ${mission.retentionExpiresAt}, 1
          )
        `;
        if (inserted !== 1) throw new ResumeAtomicAbort();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        return {
          status: 'issued' as const,
          bootstrap: {
            companyId: mission.companyId,
            sessionHandle: mission.sessionHandle,
            ticket,
            protocol: MISTRAL_CONVERSATION_PROTOCOL,
            scope,
            ticketExpiresAt: expiresAt.toISOString(),
            expectedMissionConnectionEpoch: mission.missionConnectionEpoch,
            clientAcceptedMissionConnectionEpoch: input.clientAcceptedMissionConnectionEpoch,
            resumeNextServerSequence: input.resumeNextServerSequence,
          },
        };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async reconcileInitialBootstrap(
    input: Parameters<MistralConversationResumeAuthority['reconcileInitialBootstrap']>[0],
  ): Promise<MistralConversationBootstrapReconciliationResult> {
    if (!validBootstrapReconciliationInput(input)) return { status: 'invalid' };
    if (input.signal.aborted) return { status: 'unavailable' };
    const reconciliationKeys = this.reconciliationKeys;
    const reconciliationIdentityKeys = this.reconciliationIdentityKeys;
    if (
      this.prisma.inTransaction()
      || !reconciliationKeys
      || !reconciliationIdentityKeys
    ) return { status: 'unavailable' };

    let rawBootstrapTicket = input.bootstrapTicket;
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        // Ordre canonique : bootstrap -> tentative r2 -> clé mission -> mission -> admission -> DB.
        const bootstrap = await this.lockBootstrapForReconciliation(
          tx,
          input.companyId,
          hashMistralConversationBootstrapTicket(rawBootstrapTicket),
        );
        if (!bootstrap) return { status: 'not_found' as const };
        if (
          bootstrap.companyId !== input.companyId
          || bootstrap.sessionHandle !== input.sessionHandle
          || bootstrap.protocol !== input.protocol
        ) return { status: 'forbidden' as const };

        const identityBinding = bootstrapIdentityBinding(bootstrap);
        const storedUserId = identityBinding && openMistralRealtimeUserIdentity({
          ciphertext: Uint8Array.from(bootstrap.userIdentityCiphertext),
          nonce: Uint8Array.from(bootstrap.userIdentityNonce),
          tag: Uint8Array.from(bootstrap.userIdentityTag),
          keyVersion: bootstrap.identityEncryptionKeyVersion,
        }, identityBinding, reconciliationIdentityKeys);
        if (storedUserId === null || storedUserId !== input.userId) {
          return { status: 'forbidden' as const };
        }

        if (bootstrap.state === 'issued') {
          const databaseNow = await this.databaseNow(tx);
          if (
            bootstrap.ticketExpiresAt.getTime() <= databaseNow.getTime()
            || bootstrap.hardExpiresAt.getTime() <= databaseNow.getTime()
          ) return { status: 'expired' as const };
          // Le COMMIT initial n'a pas eu lieu : le même b2 reste le seul geste autorisé.
          return { status: 'retry_initial' as const };
        }
        if (bootstrap.state !== 'consumed' || bootstrap.consumedAt === null) {
          return { status: 'unavailable' as const };
        }

        const existing = await this.lockReconciliationAttempt(
          tx,
          input.companyId,
          bootstrap.id,
          input.attempt,
        );
        await this.lockMissionKey(tx, input.companyId, input.sessionHandle);
        const mission = await this.lockMission(tx, input.companyId, input.sessionHandle);
        if (!mission || !exactBootstrapMissionBinding(bootstrap, mission)) {
          return { status: 'unavailable' as const };
        }
        const admission = await this.lockAdmission(tx, mission);
        const databaseNow = await this.databaseNow(tx);
        if (
          mission.replayGraceExpiresAt.getTime() <= databaseNow.getTime()
          || bootstrap.hardExpiresAt.getTime() !== mission.hardExpiresAt.getTime()
          || mission.retainedFromServerSequence !== 0n
          || !(await this.hasInitialReadyProof(tx, mission))
        ) return { status: 'expired' as const };

        if (existing) {
          const keyVersion = existing.reconciliationKeyVersion;
          if (keyVersion === null) return { status: 'unavailable' as const };
          const secret = reconciliationKeys.secret(keyVersion);
          if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
            return { status: 'unavailable' as const };
          }
          const secretCopy = Uint8Array.from(secret);
          const capability = (() => {
            try {
              return deriveMistralConversationBootstrapReconciliationCapability({
                secret: secretCopy,
                keyVersion,
                companyId: input.companyId,
                subjectHash: mission.subjectHash.trim(),
                initialBootstrapId: bootstrap.id,
                sessionHandle: input.sessionHandle,
                attempt: input.attempt,
              });
            } finally {
              secretCopy.fill(0);
            }
          })();
          if (
            existing.id !== capability.ticketId
            || !areMistralConversationBootstrapReconciliationTicketHashesEqual(
              existing.ticketHash,
              capability.ticketHash,
            )
            || !exactMissionBinding(existing, mission)
            || !exactResumePurposeBinding(existing, mission)
          ) return { status: 'unavailable' as const };
          if (
            existing.state === 'consumed'
            || existing.expiresAt.getTime() <= databaseNow.getTime()
            || existing.expectedMissionConnectionEpoch !== mission.missionConnectionEpoch
          ) {
            return { status: 'attempt_consumed' as const };
          }
          if (existing.state !== 'issued' || existing.version !== 1) {
            return { status: 'unavailable' as const };
          }
          if (
            existing.scope === 'live_takeover'
            && (
              databaseNow.getTime() >= mission.hardExpiresAt.getTime()
              || mission.phase === 'draining'
              || mission.phase === 'closed'
              || mission.phase === 'recovering_route'
              || !this.reconciliationAdmissionIsLive(admission, bootstrap, databaseNow)
            )
          ) return { status: 'unavailable' as const };
          if (
            existing.scope === 'terminal_replay'
            && databaseNow.getTime() < mission.hardExpiresAt.getTime()
            && mission.phase !== 'draining'
            && mission.phase !== 'closed'
          ) return { status: 'unavailable' as const };
          return {
            status: 'issued' as const,
            bootstrap: this.reconciliationBootstrap(existing, capability.ticket),
          };
        }

        const latest = await this.lockLatestReconciliationAttempt(
          tx,
          input.companyId,
          bootstrap.id,
        );
        const latestAttempt = latest?.reconciliationAttempt ?? null;
        if (
          (input.attempt === 1 && latest !== null)
          || (input.attempt > 1 && latestAttempt !== input.attempt - 1)
          || (
            latest !== null
            && latest.state === 'issued'
            && latest.expiresAt.getTime() > databaseNow.getTime()
            && latest.expectedMissionConnectionEpoch === mission.missionConnectionEpoch
          )
        ) return { status: 'unavailable' as const };

        const terminalWindow = mission.phase === 'draining'
          || mission.phase === 'closed'
          || databaseNow.getTime() >= mission.hardExpiresAt.getTime();
        const scope: MistralConversationResumeScope = terminalWindow
          ? 'terminal_replay'
          : 'live_takeover';
        if (scope === 'live_takeover') {
          if (
            mission.phase === 'recovering_route'
            || mission.missionConnectionEpoch >= INT32_MAX
            || !this.reconciliationAdmissionIsLive(admission, bootstrap, databaseNow)
          ) return { status: 'unavailable' as const };
        } else if (
          mission.replayGraceExpiresAt.getTime() - databaseNow.getTime()
            < MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS
        ) return { status: 'expired' as const };

        const absoluteBoundary = scope === 'live_takeover'
          ? mission.hardExpiresAt
          : mission.replayGraceExpiresAt;
        const expiresAt = new Date(Math.min(
          databaseNow.getTime() + this.policy.ticketTtlSeconds * 1_000,
          absoluteBoundary.getTime(),
        ));
        if (expiresAt.getTime() <= databaseNow.getTime()) return { status: 'expired' as const };

        const keyVersion = reconciliationKeys.currentVersion;
        const secret = reconciliationKeys.secret(keyVersion);
        if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
          return { status: 'unavailable' as const };
        }
        const secretCopy = Uint8Array.from(secret);
        const capability = (() => {
          try {
            return deriveMistralConversationBootstrapReconciliationCapability({
              secret: secretCopy,
              keyVersion,
              companyId: input.companyId,
              subjectHash: mission.subjectHash.trim(),
              initialBootstrapId: bootstrap.id,
              sessionHandle: input.sessionHandle,
              attempt: input.attempt,
            });
          } finally {
            secretCopy.fill(0);
          }
        })();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        const inserted = await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_resume_tickets (
            id, "companyId", "missionId", "sessionHandle", "admissionSessionId",
            "ticketHash", protocol, purpose, "initialBootstrapId", "reconciliationAttempt",
            "reconciliationKeyVersion", scope, state, "subjectHash", "subjectKeyVersion", plan,
            "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
            "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
            "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
            "replayGraceExpiresAt", "issuedAt", "expiresAt", "retentionExpiresAt", version
          ) VALUES (
            ${capability.ticketId}::uuid, ${mission.companyId}, ${mission.id}::uuid,
            ${mission.sessionHandle}, ${mission.admissionSessionId}::uuid,
            ${capability.ticketHash}, ${MISTRAL_CONVERSATION_PROTOCOL},
            'initial_bootstrap_reconciliation', ${bootstrap.id}::uuid, ${input.attempt},
            ${keyVersion}, ${scope}, 'issued', ${mission.subjectHash.trim()},
            ${mission.subjectKeyVersion}, ${mission.plan}, ${mission.missionConnectionEpoch},
            0, 0, ${mission.contextRevision}, ${mission.contextDigest.trim()},
            ${mission.routeMode}, ${mission.fullDuplexCertified}, ${mission.maxMissionAudioBytes},
            ${mission.hardExpiresAt}, ${mission.replayGraceExpiresAt}, ${databaseNow}, ${expiresAt},
            ${mission.retentionExpiresAt}, 1
          )
        `;
        if (inserted !== 1) throw new ResumeAtomicAbort();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        const persisted: ResumeTicketRow = {
          id: capability.ticketId,
          companyId: mission.companyId,
          missionId: mission.id,
          sessionHandle: mission.sessionHandle,
          admissionSessionId: mission.admissionSessionId ?? '',
          ticketHash: capability.ticketHash,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          purpose: 'initial_bootstrap_reconciliation',
          initialBootstrapId: bootstrap.id,
          reconciliationAttempt: input.attempt,
          reconciliationKeyVersion: keyVersion,
          scope,
          state: 'issued',
          subjectHash: mission.subjectHash.trim(),
          subjectKeyVersion: mission.subjectKeyVersion,
          plan: mission.plan,
          expectedMissionConnectionEpoch: mission.missionConnectionEpoch,
          clientAcceptedMissionConnectionEpoch: 0,
          resumeNextServerSequence: 0n,
          contextRevision: mission.contextRevision,
          contextDigest: mission.contextDigest.trim(),
          routeMode: mission.routeMode,
          fullDuplexCertified: mission.fullDuplexCertified,
          maxMissionAudioBytes: mission.maxMissionAudioBytes,
          hardExpiresAt: mission.hardExpiresAt,
          replayGraceExpiresAt: mission.replayGraceExpiresAt,
          issuedAt: databaseNow,
          expiresAt,
          consumedAt: null,
          consumedMissionConnectionEpoch: null,
          replayConnectionId: null,
          connectionLeaseExpiresAt: null,
          maxAcknowledgableServerSequence: null,
          retentionExpiresAt: mission.retentionExpiresAt,
          version: 1,
        };
        return {
          status: 'issued' as const,
          bootstrap: this.reconciliationBootstrap(persisted, capability.ticket),
        };
      });
    } catch {
      return { status: 'unavailable' };
    } finally {
      rawBootstrapTicket = '';
    }
  }

  async redeemAndOpen(
    input: Parameters<MistralConversationResumeAuthority['redeemAndOpen']>[0],
  ): Promise<MistralConversationRedeemAndOpenResult> {
    if (!validRedeemInput(input)) return { status: 'invalid' };
    if (input.signal.aborted) return { status: 'aborted' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    let rawTicket = input.ticket;
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const rawTicketHash = hashMistralConversationResumeTicket(rawTicket);
        const inspectedPurpose = await this.inspectTicketPurpose(
          tx,
          input.companyId,
          rawTicketHash,
        );
        if (!inspectedPurpose) return { status: 'invalid' as const };
        if (inspectedPurpose.purpose === 'initial_bootstrap_reconciliation') {
          if (
            inspectedPurpose.initialBootstrapId === null
            || !UUID.test(inspectedPurpose.initialBootstrapId)
            || !(await this.lockBootstrapEvidenceById(
              tx,
              input.companyId,
              inspectedPurpose.initialBootstrapId,
            ))
          ) return { status: 'unavailable' as const };
        }
        const ticket = await this.lockTicket(
          tx,
          input.companyId,
          rawTicketHash,
        );
        if (!ticket) return { status: 'invalid' as const };
        if (
          ticket.purpose !== inspectedPurpose.purpose
          || ticket.initialBootstrapId !== inspectedPurpose.initialBootstrapId
        ) return { status: 'unavailable' as const };
        if (ticket.scope !== input.expectedScope) return { status: 'scope_mismatch' as const };
        await this.lockMissionKey(tx, ticket.companyId, ticket.sessionHandle);
        const mission = await this.lockMission(tx, ticket.companyId, ticket.sessionHandle);
        if (
          !mission
          || !exactMissionBinding(ticket, mission)
          || !exactResumePurposeBinding(ticket, mission)
        ) {
          return { status: 'unavailable' as const };
        }
        const admission = ticket.scope === 'live_takeover'
          ? await this.lockAdmission(tx, mission)
          : null;
        const databaseNow = await this.databaseNow(tx);
        if (ticket.state !== 'issued' || ticket.version !== 1) return { status: 'replayed' as const };
        if (ticket.expiresAt.getTime() <= databaseNow.getTime()) return { status: 'expired' as const };
        if (
          ticket.expectedMissionConnectionEpoch !== mission.missionConnectionEpoch
          || ticket.clientAcceptedMissionConnectionEpoch > ticket.expectedMissionConnectionEpoch
        ) return { status: 'stale_epoch' as const };
        const ticketCursor = safeNumber(ticket.resumeNextServerSequence);
        if (ticketCursor === null || input.resumeNextServerSequence !== ticketCursor) {
          return { status: 'invalid_cursor' as const };
        }
        if (ticket.scope === 'live_takeover') {
          const reconciliationLiveTakeover = ticket.purpose
            === 'initial_bootstrap_reconciliation';
          if (
            (!this.policy.liveTakeoverEnabled && !reconciliationLiveTakeover)
            || !this.admissionIsLive(admission, databaseNow)
          ) {
            return { status: 'unavailable' as const };
          }
          if (
            databaseNow.getTime() >= mission.hardExpiresAt.getTime()
            || mission.phase === 'draining'
            || mission.phase === 'closed'
            || mission.phase === 'recovering_route'
            || mission.missionConnectionEpoch >= INT32_MAX
          ) return { status: 'scope_mismatch' as const };
        } else if (
          databaseNow.getTime() >= mission.replayGraceExpiresAt.getTime()
          || mission.replayGraceExpiresAt.getTime() - databaseNow.getTime()
            < MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS
          || (
            databaseNow.getTime() < mission.hardExpiresAt.getTime()
            && mission.phase !== 'draining'
            && mission.phase !== 'closed'
          )
        ) return { status: 'scope_mismatch' as const };
        if (input.signal.aborted) throw new ResumeAtomicAbort();

        const grant = grantFromMission(mission);
        if (!grant) return { status: 'unavailable' as const };
        const ownerLeaseToken = this.entropy.ownerLeaseToken();
        if (!isMistralConversationConnectionLeaseToken(ownerLeaseToken)) {
          return { status: 'unavailable' as const };
        }
        let terminalCapability: {
          readonly replayConnectionId: string;
          readonly connectionLeaseToken: string;
        } | null = null;
        if (ticket.scope === 'terminal_replay') {
          const replayConnectionId = this.entropy.replayConnectionId().toLowerCase();
          const connectionLeaseToken = this.entropy.terminalAcknowledgementToken();
          if (
            !isMistralConversationReplayConnectionId(replayConnectionId)
            || !isMistralConversationConnectionLeaseToken(connectionLeaseToken)
          ) return { status: 'unavailable' as const };
          terminalCapability = {
            replayConnectionId,
            connectionLeaseToken,
          };
        }
        const opened = await this.durable.openWithinTransaction(tx, {
          grant,
          ownerLeaseToken,
          resumeNextServerSequence: input.resumeNextServerSequence,
          maxReplayEvents: input.maxReplayEvents,
          maxReplayBytes: input.maxReplayBytes,
          signal: input.signal,
        }, { existingMissionId: mission.id });
        if (
          opened.status === 'invalid_cursor'
          || opened.status === 'history_unavailable'
          || opened.status === 'expired'
          || opened.status === 'unavailable'
        ) return { status: opened.status as 'invalid_cursor' | 'history_unavailable' | 'expired' | 'unavailable' };
        if (opened.status === 'conflict' || opened.status === 'opened') {
          return { status: 'unavailable' as const };
        }
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        await this.beforeTicketConsume();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        const consumedAt = await this.databaseNow(tx);
        if (input.signal.aborted) throw new ResumeAtomicAbort();

        if (ticket.scope === 'live_takeover') {
          if (
            opened.status !== 'recovered'
            && opened.status !== 'replayed'
          ) return { status: 'scope_mismatch' as const };
          const consumed = await this.consumeLiveTicket(
            tx,
            ticket,
            opened.snapshot.missionConnectionEpoch,
            consumedAt,
          );
          if (!consumed) throw new ResumeAtomicAbort();
          if (input.signal.aborted) throw new ResumeAtomicAbort();
          return {
            status: 'live_takeover' as const,
            grant,
            ownerLeaseToken,
            snapshot: opened.snapshot,
            replayFromServerSequence: opened.replayFromServerSequence,
            events: opened.events,
            recovery: opened.recovery,
            terminal: null,
            terminalAcknowledgement: null,
          };
        }

        if (opened.status !== 'terminal_replay') {
          // Un ticket terminal ne doit jamais provoquer un takeover live. Toute divergence de
          // l'adapter durable rollbacke mission/outbox et conserve la capacité non consommée.
          throw new ResumeAtomicAbort();
        }
        if (!terminalCapability) throw new ResumeAtomicAbort();
        const acknowledgementExpiresAt = new Date(Math.min(
          consumedAt.getTime() + this.policy.terminalAcknowledgementTtlSeconds * 1_000,
          ticket.replayGraceExpiresAt.getTime(),
        ));
        if (
          acknowledgementExpiresAt.getTime() - consumedAt.getTime()
            < MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS
        ) {
          // openWithinTransaction a pu terminaliser à H : cette exception rollbacke aussi
          // mission et outbox, au lieu de brûler le ticket sans replay transport possible.
          throw new ResumeExpiredAbort();
        }
        const consumed = await this.consumeTerminalTicket(tx, {
          ticket,
          missionConnectionEpoch: opened.snapshot.missionConnectionEpoch,
          replayConnectionId: terminalCapability.replayConnectionId,
          connectionLeaseTokenHash: terminalConnectionHash(
            terminalCapability.connectionLeaseToken,
          ),
          acknowledgementExpiresAt,
          maxAcknowledgableServerSequence: opened.snapshot.nextServerSequence,
          consumedAt,
        });
        if (!consumed) throw new ResumeAtomicAbort();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        return {
          status: 'terminal_replay' as const,
          grant,
          snapshot: opened.snapshot,
          replayFromServerSequence: opened.replayFromServerSequence,
          events: opened.events,
          recovery: null,
          terminal: opened.terminal,
          terminalAcknowledgement: {
            replayConnectionId: terminalCapability.replayConnectionId,
            connectionLeaseToken: terminalCapability.connectionLeaseToken,
            expiresAt: acknowledgementExpiresAt.toISOString(),
          },
        };
      });
    } catch (error) {
      if (error instanceof ResumeExpiredAbort) return { status: 'expired' };
      return input.signal.aborted ? { status: 'aborted' } : { status: 'unavailable' };
    } finally {
      rawTicket = '';
    }
  }

  async acknowledgeTerminal(
    input: Parameters<MistralConversationResumeAuthority['acknowledgeTerminal']>[0],
  ): Promise<MistralConversationTerminalAcknowledgementResult> {
    if (!validTerminalAcknowledgementInput(input)) return { status: 'invalid' };
    if (input.signal.aborted) return { status: 'aborted' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    let rawConnectionLeaseToken = input.connectionLeaseToken;
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const capability = await this.lockTerminalCapability(
          tx,
          input.companyId,
          input.replayConnectionId,
          terminalConnectionHash(rawConnectionLeaseToken),
        );
        if (!capability) return { status: 'invalid' as const };
        await this.lockMissionKey(tx, capability.companyId, capability.sessionHandle);
        const mission = await this.lockMission(tx, capability.companyId, capability.sessionHandle);
        if (
          !mission
          || !exactMissionBinding(capability, mission)
          || !exactResumePurposeBinding(capability, mission)
        ) {
          return { status: 'unavailable' as const };
        }
        const databaseNow = await this.databaseNow(tx);
        if (
          capability.scope !== 'terminal_replay'
          || capability.state !== 'consumed'
          || capability.connectionLeaseTokenHash?.trim()
            !== terminalConnectionHash(rawConnectionLeaseToken)
          || capability.connectionLeaseExpiresAt === null
          || capability.connectionLeaseExpiresAt.getTime() <= databaseNow.getTime()
          || capability.replayGraceExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'expired' as const };
        if (
          capability.subjectHash.trim() !== input.subjectHash
          || capability.sessionHandle !== input.sessionHandle
          || capability.consumedMissionConnectionEpoch !== input.missionConnectionEpoch
          || mission.missionConnectionEpoch !== input.missionConnectionEpoch
          || mission.phase !== 'closed'
        ) return { status: 'invalid' as const };
        const maximum = capability.maxAcknowledgableServerSequence === null
          ? null
          : safeNumber(capability.maxAcknowledgableServerSequence);
        const currentAcknowledgement = safeNumber(mission.acknowledgedServerSequence);
        if (
          maximum === null
          || currentAcknowledgement === null
          || input.nextServerSequence > maximum
        ) return { status: 'invalid' as const };
        if (input.nextServerSequence <= currentAcknowledgement) {
          return { status: 'replayed' as const };
        }
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        const [proofContext] = await tx.$queryRaw<Array<{
          replayConnectionId: string;
          connectionLeaseTokenHash: string;
        }>>`
          SELECT
            set_config(
              'app.mistral_terminal_ack_replay_connection_id',
              ${input.replayConnectionId},
              true
            ) AS "replayConnectionId",
            set_config(
              'app.mistral_terminal_ack_token_hash',
              ${terminalConnectionHash(rawConnectionLeaseToken)},
              true
            ) AS "connectionLeaseTokenHash"
        `;
        if (
          proofContext?.replayConnectionId !== input.replayConnectionId
          || proofContext.connectionLeaseTokenHash
            !== terminalConnectionHash(rawConnectionLeaseToken)
        ) throw new ResumeAtomicAbort();
        const updated = await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET version = version + 1,
                 "acknowledgedServerSequence" = ${BigInt(input.nextServerSequence)},
                 "updatedAt" = clock_timestamp()
           WHERE id = ${mission.id}::uuid
             AND "companyId" = ${mission.companyId}
             AND "sessionHandle" = ${mission.sessionHandle}
             AND "missionConnectionEpoch" = ${mission.missionConnectionEpoch}
             AND version = ${mission.version}
             AND phase = 'closed'
             AND "acknowledgedServerSequence" < ${BigInt(input.nextServerSequence)}
             AND "nextServerSequence" >= ${BigInt(input.nextServerSequence)}
             AND "replayGraceExpiresAt" > clock_timestamp()
             AND EXISTS (
               SELECT 1
                 FROM realtime_mistral_conversation_resume_tickets AS resume
                WHERE resume.id = ${capability.id}::uuid
                  AND resume."companyId" = ${capability.companyId}
                  AND resume.state = 'consumed'
                  AND resume.scope = 'terminal_replay'
                  AND resume."replayConnectionId" = ${input.replayConnectionId}::uuid
                  AND resume."connectionLeaseTokenHash" = ${terminalConnectionHash(rawConnectionLeaseToken)}
                  AND resume."connectionLeaseExpiresAt" > clock_timestamp()
                  AND resume."maxAcknowledgableServerSequence" >= ${BigInt(input.nextServerSequence)}
             )
        `;
        if (updated !== 1) throw new ResumeAtomicAbort();
        if (input.signal.aborted) throw new ResumeAtomicAbort();
        return { status: 'applied' as const };
      });
    } catch {
      return input.signal.aborted ? { status: 'aborted' } : { status: 'unavailable' };
    } finally {
      rawConnectionLeaseToken = '';
    }
  }

  private async databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT clock_timestamp() AS "databaseNow"
    `;
    if (!(row?.databaseNow instanceof Date) || Number.isNaN(row.databaseNow.getTime())) {
      throw new ResumeAtomicAbort();
    }
    return row.databaseNow;
  }

  private async lockMissionKey(
    tx: Prisma.TransactionClient,
    companyId: string,
    sessionHandle: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${sessionHandle}`}, 0))
    `;
  }

  private async lockMission(
    tx: Prisma.TransactionClient,
    companyId: string,
    sessionHandle: string,
  ): Promise<MissionRow | null> {
    const [row] = await tx.$queryRaw<MissionRow[]>`
      SELECT id, "companyId", "initialBootstrapId", "admissionSessionId", protocol,
             "subjectHash", "subjectKeyVersion", plan, "sessionHandle",
             "missionConnectionEpoch", version, "acknowledgedServerSequence",
             "retainedFromServerSequence", "nextServerSequence", "contextRevision",
             "contextDigest", "routeMode", "fullDuplexCertified", "maxMissionAudioBytes",
             phase, "terminalReason", "closedAt", "hardExpiresAt",
             "replayGraceExpiresAt", "retentionExpiresAt"
        FROM realtime_mistral_conversation_missions
       WHERE "companyId" = ${companyId}
         AND "sessionHandle" = ${sessionHandle}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async inspectTerminalReceipt(
    tx: Prisma.TransactionClient,
    companyId: string,
    sessionHandle: string,
  ): Promise<TerminalReceiptRow | null> {
    const [row] = await tx.$queryRaw<TerminalReceiptRow[]>`
      SELECT "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
             "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
        FROM realtime_mistral_conversation_terminal_receipts
       WHERE "companyId" = ${companyId}
         AND "sessionHandle" = ${sessionHandle}
       LIMIT 1
    `;
    return row ?? null;
  }

  private async lockTicket(
    tx: Prisma.TransactionClient,
    companyId: string,
    hash: string,
  ): Promise<ResumeTicketRow | null> {
    const [row] = await tx.$queryRaw<ResumeTicketRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", "ticketHash", protocol,
             purpose, "initialBootstrapId", "reconciliationAttempt",
             "reconciliationKeyVersion", scope, state, "subjectHash", "subjectKeyVersion", plan,
             "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
             "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
             "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
             "replayGraceExpiresAt", "issuedAt", "expiresAt", "consumedAt",
             "consumedMissionConnectionEpoch", "replayConnectionId",
             "connectionLeaseExpiresAt", "maxAcknowledgableServerSequence",
             "retentionExpiresAt", version
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "companyId" = ${companyId}
         AND "ticketHash" = ${hash}
         AND protocol = ${MISTRAL_CONVERSATION_PROTOCOL}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async inspectTicketPurpose(
    tx: Prisma.TransactionClient,
    companyId: string,
    hash: string,
  ): Promise<ResumeTicketPurposeRow | null> {
    const [row] = await tx.$queryRaw<ResumeTicketPurposeRow[]>`
      SELECT purpose, "initialBootstrapId"
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "companyId" = ${companyId}
         AND "ticketHash" = ${hash}
         AND protocol = ${MISTRAL_CONVERSATION_PROTOCOL}
       LIMIT 1
    `;
    return row ?? null;
  }

  private async lockBootstrapEvidenceById(
    tx: Prisma.TransactionClient,
    companyId: string,
    initialBootstrapId: string,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
        FROM realtime_mistral_conversation_bootstrap_tickets
       WHERE "companyId" = ${companyId}
         AND id = ${initialBootstrapId}::uuid
       FOR UPDATE
    `;
    return row?.id === initialBootstrapId;
  }

  private async lockTerminalCapability(
    tx: Prisma.TransactionClient,
    companyId: string,
    replayConnectionId: string,
    connectionLeaseTokenHash: string,
  ): Promise<TerminalCapabilityRow | null> {
    const [row] = await tx.$queryRaw<TerminalCapabilityRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", "ticketHash", protocol,
             purpose, "initialBootstrapId", "reconciliationAttempt",
             "reconciliationKeyVersion", scope, state, "subjectHash", "subjectKeyVersion", plan,
             "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
             "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
             "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
             "replayGraceExpiresAt", "issuedAt", "expiresAt", "consumedAt",
             "consumedMissionConnectionEpoch", "replayConnectionId",
             "connectionLeaseTokenHash", "connectionLeaseExpiresAt",
             "maxAcknowledgableServerSequence", "retentionExpiresAt", version
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "companyId" = ${companyId}
         AND "replayConnectionId" = ${replayConnectionId}::uuid
         AND "connectionLeaseTokenHash" = ${connectionLeaseTokenHash}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async lockAdmission(
    tx: Prisma.TransactionClient,
    mission: MissionRow,
  ): Promise<AdmissionLeaseRow | null> {
    if (mission.admissionSessionId === null) return null;
    const [row] = await tx.$queryRaw<AdmissionLeaseRow[]>`
      SELECT state, "providerId", "providerCallId", "leaseExpiresAt", "hardExpiresAt"
        FROM realtime_session_leases
       WHERE "companyId" = ${mission.companyId}
         AND "subjectHash" = ${mission.subjectHash.trim()}
         AND "sessionId" = ${mission.admissionSessionId}::uuid
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async lockBootstrapForReconciliation(
    tx: Prisma.TransactionClient,
    companyId: string,
    bootstrapTicketHash: string,
  ): Promise<BootstrapReconciliationRow | null> {
    const [row] = await tx.$queryRaw<BootstrapReconciliationRow[]>`
      SELECT id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
             "subjectKeyVersion", "admissionLeaseTokenHash", protocol, state, plan,
             "contextRevision", "contextDigest", "userIdentityCiphertext",
             "userIdentityNonce", "userIdentityTag", "identityEncryptionKeyVersion",
             "routeMode", "fullDuplexCertified", "maxMissionAudioBytes",
             "ticketExpiresAt", "hardExpiresAt", "consumedAt", "retentionExpiresAt"
        FROM realtime_mistral_conversation_bootstrap_tickets
       WHERE "companyId" = ${companyId}
         AND "ticketHash" = ${bootstrapTicketHash}
         AND protocol = ${MISTRAL_CONVERSATION_PROTOCOL}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async lockReconciliationAttempt(
    tx: Prisma.TransactionClient,
    companyId: string,
    initialBootstrapId: string,
    attempt: number,
  ): Promise<ResumeTicketRow | null> {
    const [row] = await tx.$queryRaw<ResumeTicketRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", "ticketHash", protocol,
             purpose, "initialBootstrapId", "reconciliationAttempt",
             "reconciliationKeyVersion", scope, state, "subjectHash", "subjectKeyVersion", plan,
             "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
             "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
             "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
             "replayGraceExpiresAt", "issuedAt", "expiresAt", "consumedAt",
             "consumedMissionConnectionEpoch", "replayConnectionId",
             "connectionLeaseExpiresAt", "maxAcknowledgableServerSequence",
             "retentionExpiresAt", version
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "companyId" = ${companyId}
         AND "initialBootstrapId" = ${initialBootstrapId}::uuid
         AND "reconciliationAttempt" = ${attempt}
         AND purpose = 'initial_bootstrap_reconciliation'
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async lockLatestReconciliationAttempt(
    tx: Prisma.TransactionClient,
    companyId: string,
    initialBootstrapId: string,
  ): Promise<ResumeTicketRow | null> {
    const [row] = await tx.$queryRaw<ResumeTicketRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", "ticketHash", protocol,
             purpose, "initialBootstrapId", "reconciliationAttempt",
             "reconciliationKeyVersion", scope, state, "subjectHash", "subjectKeyVersion", plan,
             "expectedMissionConnectionEpoch", "clientAcceptedMissionConnectionEpoch",
             "resumeNextServerSequence", "contextRevision", "contextDigest", "routeMode",
             "fullDuplexCertified", "maxMissionAudioBytes", "hardExpiresAt",
             "replayGraceExpiresAt", "issuedAt", "expiresAt", "consumedAt",
             "consumedMissionConnectionEpoch", "replayConnectionId",
             "connectionLeaseExpiresAt", "maxAcknowledgableServerSequence",
             "retentionExpiresAt", version
        FROM realtime_mistral_conversation_resume_tickets
       WHERE "companyId" = ${companyId}
         AND "initialBootstrapId" = ${initialBootstrapId}::uuid
         AND purpose = 'initial_bootstrap_reconciliation'
       ORDER BY "reconciliationAttempt" DESC
       LIMIT 1
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async hasInitialReadyProof(
    tx: Prisma.TransactionClient,
    mission: MissionRow,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<Array<{ ready: boolean }>>`
      SELECT EXISTS (
        SELECT 1
          FROM realtime_mistral_conversation_outbox AS outbox
         WHERE outbox."companyId" = ${mission.companyId}
           AND outbox."missionId" = ${mission.id}::uuid
           AND outbox."sessionHandle" = ${mission.sessionHandle}
           AND outbox."serverSequence" = 0
           AND outbox."eventType" = 'session.ready'
      ) AS ready
    `;
    return row?.ready === true;
  }

  private admissionIsLive(admission: AdmissionLeaseRow | null, observedNow: Date): boolean {
    return admission !== null
      && admission.state === 'active'
      && admission.leaseExpiresAt.getTime() > observedNow.getTime()
      && admission.hardExpiresAt.getTime() > observedNow.getTime();
  }

  private reconciliationAdmissionIsLive(
    admission: AdmissionLeaseRow | null,
    bootstrap: BootstrapReconciliationRow,
    observedNow: Date,
  ): boolean {
    return this.admissionIsLive(admission, observedNow)
      && admission?.providerId === 'mistral'
      && admission.providerCallId === `mcv2:${bootstrap.id}`
      && admission.hardExpiresAt.getTime() === bootstrap.hardExpiresAt.getTime();
  }

  private reconciliationBootstrap(
    ticket: ResumeTicketRow,
    rawTicket: string,
  ): Extract<
  MistralConversationBootstrapReconciliationResult,
  { readonly status: 'issued' }
  >['bootstrap'] {
    return Object.freeze({
      companyId: ticket.companyId,
      sessionHandle: ticket.sessionHandle,
      ticket: rawTicket,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      scope: ticket.scope,
      ticketExpiresAt: ticket.expiresAt.toISOString(),
      expectedMissionConnectionEpoch: ticket.expectedMissionConnectionEpoch,
      clientAcceptedMissionConnectionEpoch: 0,
      resumeNextServerSequence: 0,
    });
  }

  private async consumeLiveTicket(
    tx: Prisma.TransactionClient,
    ticket: ResumeTicketRow,
    missionConnectionEpoch: number,
    consumedAt: Date,
  ): Promise<boolean> {
    const consumed = await tx.$executeRaw`
      UPDATE realtime_mistral_conversation_resume_tickets
         SET state = 'consumed', "consumedAt" = ${consumedAt},
             "consumedMissionConnectionEpoch" = ${missionConnectionEpoch}, version = version + 1
       WHERE id = ${ticket.id}::uuid
         AND "companyId" = ${ticket.companyId}
         AND state = 'issued' AND version = 1
         AND "expiresAt" > clock_timestamp()
    `;
    return consumed === 1;
  }

  private async consumeTerminalTicket(
    tx: Prisma.TransactionClient,
    input: {
      readonly ticket: ResumeTicketRow;
      readonly missionConnectionEpoch: number;
      readonly replayConnectionId: string;
      readonly connectionLeaseTokenHash: string;
      readonly acknowledgementExpiresAt: Date;
      readonly maxAcknowledgableServerSequence: number;
      readonly consumedAt: Date;
    },
  ): Promise<boolean> {
    const consumed = await tx.$executeRaw`
      UPDATE realtime_mistral_conversation_resume_tickets
         SET state = 'consumed', "consumedAt" = ${input.consumedAt},
             "consumedMissionConnectionEpoch" = ${input.missionConnectionEpoch},
             "replayConnectionId" = ${input.replayConnectionId}::uuid,
             "connectionLeaseTokenHash" = ${input.connectionLeaseTokenHash},
             "connectionLeaseExpiresAt" = ${input.acknowledgementExpiresAt},
             "maxAcknowledgableServerSequence" = ${BigInt(input.maxAcknowledgableServerSequence)},
             version = version + 1
       WHERE id = ${input.ticket.id}::uuid
         AND "companyId" = ${input.ticket.companyId}
         AND state = 'issued' AND version = 1
         AND "expiresAt" > clock_timestamp()
    `;
    return consumed === 1;
  }
}
