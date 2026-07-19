import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  MISTRAL_CONVERSATION_PROTOCOL,
  type MistralConversationResumeScope,
  type MistralConversationServerEvent,
  type MistralConversationSessionEndReason,
} from '@bob/ai';
import type {
  MistralConversationBootstrapGrant,
  MistralConversationDurableSnapshot,
  MistralConversationRecoveryMetadata,
} from './mistral-conversation-gateway-v2';

const INT32_MAX = 0x7fff_ffff;
const UINT32_CURSOR_END = 0x1_0000_0000;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUBJECT_HASH = /^[a-f0-9]{64}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const CONNECTION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RESUME_TICKET = /^r2_[A-Za-z0-9_-]{43}$/u;
const RESUME_TICKET_HASH_DOMAIN = 'bob-pro:mistral-v2-resume-ticket:v1\0';
const TERMINAL_REASONS: ReadonlySet<MistralConversationSessionEndReason> = new Set([
  'user',
  'background',
  'context_changed',
  'client_handoff',
  'expired',
  'service_shutdown',
  'fatal_error',
]);

export type { MistralConversationResumeScope } from '@bob/ai';

export interface MistralConversationResumeTicketPolicy {
  /** TTL court de la capacité HTTP -> WSS, toujours borné ensuite par H ou G en BDD. */
  readonly ticketTtlSeconds: number;
  /** Fenêtre durant laquelle un replay terminal peut avancer son ACK, toujours bornée par G. */
  readonly terminalAcknowledgementTtlSeconds: number;
  /** Quota sérialisé sous le verrou mission, sans nouvel événement d'admission. */
  readonly maxOutstandingTicketsPerMission: number;
  /** Reste false tant que le lease/reaper Mistral v2 provider-neutral n'est pas certifié. */
  readonly liveTakeoverEnabled: boolean;
}

export const DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY:
MistralConversationResumeTicketPolicy = Object.freeze({
  ticketTtlSeconds: 30,
  // Le TTL commence au commit du redeem, donc avant l'envoi du replay. Vingt secondes
  // laissent le budget nominal de 10 s au replay et une vraie fenêtre d'ACK ensuite.
  terminalAcknowledgementTtlSeconds: 20,
  maxOutstandingTicketsPerMission: 3,
  liveTakeoverEnabled: false,
});

/**
 * Fenêtre minimale créée par l'autorité pour replay + persistance de l'ACK final.
 * Six secondes garantissent encore au moins une seconde de replay avec une base distante
 * décalée de ±1 s, tout en conservant les trois secondes exclusivement réservées à l'ACK.
 */
export const MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS = 6_000;
/** Portion de la capability que le transport réserve exclusivement à l'ACK final. */
export const MISTRAL_CONVERSATION_TERMINAL_ACK_RESERVE_MS = 3_000;

export interface MistralConversationResumeTicketEntropy {
  ticketId(): string;
  ticket(): string;
  replayConnectionId(): string;
  ownerLeaseToken(): string;
  terminalAcknowledgementToken(): string;
}

export const secureMistralConversationResumeTicketEntropy:
MistralConversationResumeTicketEntropy = Object.freeze({
  ticketId: () => randomUUID(),
  // Le préfixe sépare sans ambiguïté les capacités resume v2 des tickets de bootstrap v1/v2.
  ticket: () => `r2_${randomBytes(32).toString('base64url')}`,
  replayConnectionId: () => randomUUID(),
  ownerLeaseToken: () => randomBytes(32).toString('base64url'),
  terminalAcknowledgementToken: () => randomBytes(32).toString('base64url'),
});

export function isMistralConversationResumeTicket(value: unknown): value is string {
  return typeof value === 'string' && RESUME_TICKET.test(value);
}

/** Le domaine est partagé par émission aléatoire et réconciliation déterministe. */
export function hashMistralConversationResumeTicket(ticket: string): string {
  return createHash('sha256')
    .update(RESUME_TICKET_HASH_DOMAIN, 'utf8')
    .update(ticket, 'utf8')
    .digest('hex');
}

export function isMistralConversationSessionHandle(value: unknown): value is string {
  return typeof value === 'string' && SESSION_HANDLE.test(value);
}

export function validateMistralConversationResumeTicketPolicy(
  policy: MistralConversationResumeTicketPolicy,
): void {
  if (
    !Number.isSafeInteger(policy.ticketTtlSeconds)
    || policy.ticketTtlSeconds < 5
    || policy.ticketTtlSeconds > 120
    || !Number.isSafeInteger(policy.terminalAcknowledgementTtlSeconds)
    || policy.terminalAcknowledgementTtlSeconds
      < MISTRAL_CONVERSATION_MIN_TERMINAL_CAPABILITY_MS / 1_000
    || policy.terminalAcknowledgementTtlSeconds > 30
    || policy.terminalAcknowledgementTtlSeconds > policy.ticketTtlSeconds
    || !Number.isSafeInteger(policy.maxOutstandingTicketsPerMission)
    || policy.maxOutstandingTicketsPerMission < 1
    || policy.maxOutstandingTicketsPerMission > 10
    || typeof policy.liveTakeoverEnabled !== 'boolean'
  ) throw new Error('Invalid Mistral conversation resume ticket policy.');
}

export interface MistralConversationResumeTicketIssueInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  /** Anciennes versions encore retenues ; jamais fournies par le client HTTP. */
  readonly historicalSubjectBindings?: readonly MistralConversationSubjectBinding[];
  readonly sessionHandle: string;
  /** Dernier epoch que le mobile a effectivement appliqué, jamais une autorité serveur. */
  readonly clientAcceptedMissionConnectionEpoch: number;
  /** Première séquence serveur dont les effets ne sont pas encore appliqués localement. */
  readonly resumeNextServerSequence: number;
  readonly signal: AbortSignal;
}

export interface MistralConversationSubjectBinding {
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
}

export interface MistralConversationResumeTicketBootstrap {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  readonly scope: MistralConversationResumeScope;
  readonly ticketExpiresAt: string;
  readonly expectedMissionConnectionEpoch: number;
  readonly clientAcceptedMissionConnectionEpoch: number;
  readonly resumeNextServerSequence: number;
}

/**
 * Reçu terminal durable et non sensible.
 *
 * Cette projection survit à la rétention de Mission afin qu'un mobile resté hors ligne puisse
 * converger vers `closed` sans inventer une fermeture locale. L'identité propriétaire reste
 * uniquement côté serveur (`subjectHash`) et n'est jamais exposée sur le wire.
 */
export interface MistralConversationTerminalReceipt {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  readonly missionConnectionEpoch: number;
  readonly nextServerSequence: number;
  readonly reason: MistralConversationSessionEndReason;
  readonly closedAt: string;
}

export type MistralConversationResumeTicketIssueResult =
  | { readonly status: 'issued'; readonly bootstrap: MistralConversationResumeTicketBootstrap }
  | { readonly status: 'terminal_complete'; readonly receipt: MistralConversationTerminalReceipt }
  | {
      readonly status:
        | 'invalid'
        | 'not_found'
        | 'forbidden'
        | 'expired'
        | 'stale_epoch'
        | 'invalid_cursor'
        | 'history_unavailable'
        | 'unavailable';
    };

export interface MistralConversationBootstrapReconciliationInput {
  readonly companyId: string;
  /** Identité authentifiée courante, comparée à l'identité AEAD historique du bootstrap. */
  readonly userId: string;
  readonly sessionHandle: string;
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  /** Capacité initiale gardée uniquement en mémoire par le mobile jusqu'à session.ready. */
  readonly bootstrapTicket: string;
  /** Tentative monotone bornée ; la même tentative restitue la même capacité r2 encore valide. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type MistralConversationBootstrapReconciliationResult =
  | { readonly status: 'retry_initial' | 'attempt_consumed' }
  | { readonly status: 'issued'; readonly bootstrap: MistralConversationResumeTicketBootstrap }
  | {
      readonly status:
        | 'invalid'
        | 'not_found'
        | 'forbidden'
        | 'expired'
        | 'unavailable';
    };

interface MistralConversationRedeemedReplay {
  readonly grant: MistralConversationBootstrapGrant;
  readonly snapshot: MistralConversationDurableSnapshot;
  readonly replayFromServerSequence: number;
  readonly events: readonly MistralConversationServerEvent[];
}

export type MistralConversationRedeemAndOpenResult =
  | (MistralConversationRedeemedReplay & {
      readonly status: 'live_takeover';
      /** Secret process-local du nouvel owner ; jamais sérialisé sur le wire. */
      readonly ownerLeaseToken: string;
      readonly recovery: MistralConversationRecoveryMetadata;
      readonly terminal: null;
      readonly terminalAcknowledgement: null;
    })
  | (MistralConversationRedeemedReplay & {
      readonly status: 'terminal_replay';
      readonly recovery: null;
      readonly terminal: {
        readonly missionConnectionEpoch: number;
        readonly closedAtServerSequence: number;
        readonly reason: MistralConversationSessionEndReason;
        readonly replayGraceExpiresAt: string;
      };
      readonly terminalAcknowledgement: {
        /** Localisateur opaque non secret de la capacité ACK attachée à cette connexion. */
        readonly replayConnectionId: string;
        readonly expiresAt: string;
        /** Secret process-local du seul ACK terminal ; jamais sérialisé sur le wire. */
        readonly connectionLeaseToken: string;
      };
    })
  | {
      readonly status:
        | 'invalid'
        | 'expired'
        | 'replayed'
        | 'stale_epoch'
        | 'scope_mismatch'
        | 'invalid_cursor'
        | 'history_unavailable'
        | 'aborted'
        | 'unavailable';
    };

export type MistralConversationTerminalAcknowledgementResult =
  | { readonly status: 'applied' | 'replayed' }
  | { readonly status: 'expired' | 'invalid' | 'aborted' | 'unavailable' };

export interface MistralConversationResumeAuthority {
  issue(
    input: MistralConversationResumeTicketIssueInput,
  ): Promise<MistralConversationResumeTicketIssueResult>;

  /**
   * Répare uniquement l'ambiguïté « COMMIT PostgreSQL réussi / réponse WSS perdue » du bootstrap
   * initial. Ce chemin ne peut pas ouvrir la reprise live générale.
   */
  reconcileInitialBootstrap(
    input: MistralConversationBootstrapReconciliationInput,
  ): Promise<MistralConversationBootstrapReconciliationResult>;

  /**
   * Possède la transaction PostgreSQL racine. Tout takeover/replay restitué consomme son ticket
   * au même commit ; aucun appel à `bootstrap.consume()` ou `authority.open()` n'est permis.
   * Exception de sûreté volontaire : à H, la fermeture monotone peut gagner même si le replay
   * est ensuite impossible (curseur/historique), auquel cas le ticket reste émis et sans succès.
   */
  redeemAndOpen(input: {
    readonly companyId: string;
    readonly ticket: string;
    readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
    /** Scope attendu par le transport, comparé sous lock avant toute mutation de mission. */
    readonly expectedScope: MistralConversationResumeScope;
    readonly resumeNextServerSequence: number;
    readonly maxReplayEvents: number;
    readonly maxReplayBytes: number;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationRedeemAndOpenResult>;

  /** Capacité terminale étroite : elle ne peut qu'avancer le curseur ACK. */
  acknowledgeTerminal(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionHandle: string;
    readonly missionConnectionEpoch: number;
    readonly replayConnectionId: string;
    readonly connectionLeaseToken: string;
    readonly nextServerSequence: number;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationTerminalAcknowledgementResult>;
}

export class DisabledMistralConversationResumeAuthority
implements MistralConversationResumeAuthority {
  async issue(): Promise<MistralConversationResumeTicketIssueResult> {
    return { status: 'unavailable' };
  }

  async redeemAndOpen(): Promise<MistralConversationRedeemAndOpenResult> {
    return { status: 'unavailable' };
  }

  async reconcileInitialBootstrap():
  Promise<MistralConversationBootstrapReconciliationResult> {
    return { status: 'unavailable' };
  }

  async acknowledgeTerminal(): Promise<MistralConversationTerminalAcknowledgementResult> {
    return { status: 'unavailable' };
  }
}

export function isMistralConversationResumeIssueInput(
  input: MistralConversationResumeTicketIssueInput,
): boolean {
  const historical = input.historicalSubjectBindings ?? [];
  const versions = new Set<number>([input.subjectKeyVersion]);
  const hashes = new Set<string>([input.subjectHash]);
  const historicalValid = Array.isArray(historical)
    && historical.length <= 31
    && historical.every((binding) => {
      if (
        binding === null
        || typeof binding !== 'object'
        || !SUBJECT_HASH.test(binding.subjectHash)
        || !Number.isSafeInteger(binding.subjectKeyVersion)
        || binding.subjectKeyVersion < 1
        || binding.subjectKeyVersion > INT32_MAX
        || versions.has(binding.subjectKeyVersion)
        || hashes.has(binding.subjectHash)
      ) return false;
      versions.add(binding.subjectKeyVersion);
      hashes.add(binding.subjectHash);
      return true;
    });
  return historicalValid
    && COMPANY_ID.test(input.companyId)
    && SUBJECT_HASH.test(input.subjectHash)
    && Number.isSafeInteger(input.subjectKeyVersion)
    && input.subjectKeyVersion >= 1
    && input.subjectKeyVersion <= INT32_MAX
    && SESSION_HANDLE.test(input.sessionHandle)
    && Number.isSafeInteger(input.clientAcceptedMissionConnectionEpoch)
    && input.clientAcceptedMissionConnectionEpoch >= 1
    && input.clientAcceptedMissionConnectionEpoch <= INT32_MAX
    && Number.isSafeInteger(input.resumeNextServerSequence)
    && !Object.is(input.resumeNextServerSequence, -0)
    && input.resumeNextServerSequence >= 0
    && input.resumeNextServerSequence <= UINT32_CURSOR_END;
}

export function isMistralConversationTerminalReceipt(
  value: MistralConversationTerminalReceipt,
): boolean {
  const closedAt = Date.parse(value.closedAt);
  return COMPANY_ID.test(value.companyId)
    && SESSION_HANDLE.test(value.sessionHandle)
    && value.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && Number.isSafeInteger(value.missionConnectionEpoch)
    && value.missionConnectionEpoch >= 1
    && value.missionConnectionEpoch <= INT32_MAX
    && Number.isSafeInteger(value.nextServerSequence)
    && !Object.is(value.nextServerSequence, -0)
    // session.ready, session.draining et session.closed ont nécessairement été alloués.
    && value.nextServerSequence >= 3
    && value.nextServerSequence <= UINT32_CURSOR_END
    && TERMINAL_REASONS.has(value.reason)
    && Number.isFinite(closedAt)
    && new Date(closedAt).toISOString() === value.closedAt;
}

export function isMistralConversationConnectionLeaseToken(value: unknown): value is string {
  return typeof value === 'string' && CONNECTION_TOKEN.test(value);
}

export function isMistralConversationReplayConnectionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
