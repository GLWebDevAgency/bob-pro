import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type { MistralConversationBootstrapGrant } from './mistral-conversation-gateway-v2';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
  MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS,
  isMistralConversationConnectionLeaseToken,
  isMistralConversationReplayConnectionId,
  isMistralConversationResumeIssueInput,
  isMistralConversationResumeTicket,
  secureMistralConversationResumeTicketEntropy,
  validateMistralConversationResumeTicketPolicy,
  type MistralConversationRedeemAndOpenResult,
  type MistralConversationResumeAuthority,
  type MistralConversationResumeScope,
  type MistralConversationResumeTicketEntropy,
  type MistralConversationResumeTicketIssueInput,
  type MistralConversationResumeTicketIssueResult,
  type MistralConversationResumeTicketPolicy,
  type MistralConversationTerminalAcknowledgementResult,
} from './mistral-conversation-resume-ticket';

const INT32_MAX = 0x7fff_ffff;
const UINT32_CURSOR_END = 0x1_0000_0000;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SUBJECT_HASH = /^[a-f0-9]{64}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const TICKET_HASH_DOMAIN = 'bob-pro:mistral-v2-resume-ticket:v1\0';
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
  readonly hardExpiresAt: Date;
  readonly replayGraceExpiresAt: Date;
  readonly retentionExpiresAt: Date;
}

interface ResumeTicketRow {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string;
  readonly sessionHandle: string;
  readonly admissionSessionId: string;
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
}

interface TerminalCapabilityRow extends ResumeTicketRow {
  readonly connectionLeaseTokenHash: string | null;
}

interface AdmissionLeaseRow {
  readonly state: string;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
}

interface ResumeAuthorityOptions {
  readonly policy?: MistralConversationResumeTicketPolicy;
  readonly entropy?: MistralConversationResumeTicketEntropy;
  /** Failpoint déterministe : toute erreur doit rollback mission, outbox et ticket ensemble. */
  readonly beforeTicketConsume?: () => void | Promise<void>;
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

function ticketHash(ticket: string): string {
  return domainHash(TICKET_HASH_DOMAIN, ticket);
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
 * Autorité PostgreSQL des capacités de reprise v2. Elle reste non composée dans le runtime actif :
 * le live takeover ne pourra être activé qu'avec le lease/reaper provider-neutral décrit dans
 * l'ADR. Les tests PostgreSQL peuvent néanmoins certifier le protocole atomique sous gate explicite.
 */
export class PrismaMistralConversationResumeAuthority
implements MistralConversationResumeAuthority {
  private readonly policy: MistralConversationResumeTicketPolicy;
  private readonly entropy: MistralConversationResumeTicketEntropy;
  private readonly beforeTicketConsume: () => void | Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly durable: PrismaMistralConversationDurableAuthority,
    options: ResumeAuthorityOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY;
    validateMistralConversationResumeTicketPolicy(this.policy);
    this.entropy = options.entropy ?? secureMistralConversationResumeTicketEntropy;
    this.beforeTicketConsume = options.beforeTicketConsume ?? (() => undefined);
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
        if (!mission) return { status: 'not_found' as const };
        let databaseNow = await this.databaseNow(tx);
        if (
          mission.admissionSessionId === null
          || mission.subjectHash.trim() !== input.subjectHash
          || mission.subjectKeyVersion !== input.subjectKeyVersion
        ) return { status: 'forbidden' as const };
        if (mission.replayGraceExpiresAt.getTime() <= databaseNow.getTime()) {
          return { status: 'expired' as const };
        }
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
        // Seule cette preuve BDD autorise le mobile à supprimer son checkpoint. Une fermeture
        // WebSocket 1000 ne suffit pas : la capacité ACK peut avoir expiré entre l'envoi du
        // terminal et sa consommation. Aucun ticket n'est créé lorsque le terminal est déjà
        // intégralement acquitté et que le client présente exactement le curseur final.
        if (
          mission.phase === 'closed'
          && input.resumeNextServerSequence === nextServerSequence
          && acknowledgedServerSequence === nextServerSequence
        ) return { status: 'terminal_complete' as const };
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
            ${mission.admissionSessionId}::uuid, ${ticketHash(ticket)}, ${MISTRAL_CONVERSATION_PROTOCOL},
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

  async redeemAndOpen(
    input: Parameters<MistralConversationResumeAuthority['redeemAndOpen']>[0],
  ): Promise<MistralConversationRedeemAndOpenResult> {
    if (!validRedeemInput(input)) return { status: 'invalid' };
    if (input.signal.aborted) return { status: 'aborted' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    let rawTicket = input.ticket;
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const ticket = await this.lockTicket(tx, input.companyId, ticketHash(rawTicket));
        if (!ticket) return { status: 'invalid' as const };
        if (ticket.scope !== input.expectedScope) return { status: 'scope_mismatch' as const };
        await this.lockMissionKey(tx, ticket.companyId, ticket.sessionHandle);
        const mission = await this.lockMission(tx, ticket.companyId, ticket.sessionHandle);
        if (!mission || !exactMissionBinding(ticket, mission)) {
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
          if (!this.policy.liveTakeoverEnabled || !this.admissionIsLive(admission, databaseNow)) {
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
        if (!mission || !exactMissionBinding(capability, mission)) {
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
             phase, "hardExpiresAt", "replayGraceExpiresAt", "retentionExpiresAt"
        FROM realtime_mistral_conversation_missions
       WHERE "companyId" = ${companyId}
         AND "sessionHandle" = ${sessionHandle}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async lockTicket(
    tx: Prisma.TransactionClient,
    companyId: string,
    hash: string,
  ): Promise<ResumeTicketRow | null> {
    const [row] = await tx.$queryRaw<ResumeTicketRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", protocol,
             scope, state, "subjectHash", "subjectKeyVersion", plan,
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

  private async lockTerminalCapability(
    tx: Prisma.TransactionClient,
    companyId: string,
    replayConnectionId: string,
    connectionLeaseTokenHash: string,
  ): Promise<TerminalCapabilityRow | null> {
    const [row] = await tx.$queryRaw<TerminalCapabilityRow[]>`
      SELECT id, "companyId", "missionId", "sessionHandle", "admissionSessionId", protocol,
             scope, state, "subjectHash", "subjectKeyVersion", plan,
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
    const [row] = await tx.$queryRaw<Array<{
      state: string;
      leaseExpiresAt: Date;
      hardExpiresAt: Date;
    }>>`
      SELECT state, "leaseExpiresAt", "hardExpiresAt"
        FROM realtime_session_leases
       WHERE "companyId" = ${mission.companyId}
         AND "subjectHash" = ${mission.subjectHash.trim()}
         AND "sessionId" = ${mission.admissionSessionId}::uuid
       FOR UPDATE
    `;
    return row ?? null;
  }

  private admissionIsLive(admission: AdmissionLeaseRow | null, observedNow: Date): boolean {
    return admission !== null
      && admission.state === 'active'
      && admission.leaseExpiresAt.getTime() > observedNow.getTime()
      && admission.hardExpiresAt.getTime() > observedNow.getTime();
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
