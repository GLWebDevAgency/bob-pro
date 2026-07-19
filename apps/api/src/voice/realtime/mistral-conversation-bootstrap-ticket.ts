import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_PROTOCOL,
} from '@bob/ai';
import type { PlanTier } from '@bob/core';
import type { RealtimeAdmissionLease } from './realtime-admission';
import type {
  MistralConversationBootstrapAuthority,
  MistralConversationBootstrapOpenResult,
} from './mistral-conversation-gateway-v2';

const BOOTSTRAP_TICKET = /^b2_[A-Za-z0-9_-]{43}$/u;
const TICKET_HASH_DOMAIN = 'bob-pro:mistral-conversation-bootstrap-ticket:sha256:v1\u0000';
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_SESSION_SECONDS = 15 * 60;

export interface MistralConversationBootstrapTicketPolicy {
  /** Fenêtre HTTP -> première trame WSS, toujours bornée par le bail d'admission en BDD. */
  readonly ticketTtlSeconds: number;
  /** Conservation de la preuve one-shot après la borne dure de session. */
  readonly retentionSeconds: number;
  /** Tickets non terminaux, sérialisés sous un verrou tenant. */
  readonly maxOutstandingPerTenant: number;
  readonly maxOutstandingPerSubject: number;
  /** Émissions sur une heure glissante. */
  readonly maxIssuesPerTenantHour: number;
  readonly maxIssuesPerSubjectHour: number;
  /** Budget PCM mission, réduit ensuite à la durée dure réellement restante. */
  readonly maxMissionAudioBytes: number;
}

export const DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY:
MistralConversationBootstrapTicketPolicy = Object.freeze({
  ticketTtlSeconds: 30,
  retentionSeconds: 86_400,
  maxOutstandingPerTenant: 25,
  maxOutstandingPerSubject: 3,
  maxIssuesPerTenantHour: 1_000,
  maxIssuesPerSubjectHour: 120,
  maxMissionAudioBytes: MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
});

export function validateMistralConversationBootstrapTicketPolicy(
  policy: MistralConversationBootstrapTicketPolicy,
): void {
  const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
  if (
    !positiveInteger(policy.ticketTtlSeconds)
    || policy.ticketTtlSeconds < 5
    || policy.ticketTtlSeconds > 120
    || !positiveInteger(policy.retentionSeconds)
    || policy.retentionSeconds < 3_600
    || policy.retentionSeconds > 604_800
    || !positiveInteger(policy.maxOutstandingPerTenant)
    || policy.maxOutstandingPerTenant > 1_000
    || !positiveInteger(policy.maxOutstandingPerSubject)
    || policy.maxOutstandingPerSubject > policy.maxOutstandingPerTenant
    || !positiveInteger(policy.maxIssuesPerTenantHour)
    || policy.maxIssuesPerTenantHour < policy.maxOutstandingPerTenant
    || policy.maxIssuesPerTenantHour > 100_000
    || !positiveInteger(policy.maxIssuesPerSubjectHour)
    || policy.maxIssuesPerSubjectHour < policy.maxOutstandingPerSubject
    || policy.maxIssuesPerSubjectHour > policy.maxIssuesPerTenantHour
    || !positiveInteger(policy.maxMissionAudioBytes)
    || policy.maxMissionAudioBytes < MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES
    || policy.maxMissionAudioBytes > MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES
    || policy.maxMissionAudioBytes > MAX_SESSION_SECONDS * PCM_BYTES_PER_SECOND
    || policy.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
  ) throw new Error('Invalid Mistral conversation bootstrap ticket policy.');
}

export interface MistralConversationBootstrapTicketEntropy {
  readonly ticketId: () => string;
  readonly ticket: () => string;
}

export const secureMistralConversationBootstrapTicketEntropy:
MistralConversationBootstrapTicketEntropy = Object.freeze({
  ticketId: randomUUID,
  // 256 bits, encodés sans padding : le préfixe distingue cette capacité du v1 et des `r2_`.
  ticket: () => `b2_${randomBytes(32).toString('base64url')}`,
});

export function isMistralConversationBootstrapTicket(value: unknown): value is string {
  if (typeof value !== 'string' || !BOOTSTRAP_TICKET.test(value)) return false;
  try {
    const payload = value.slice(3);
    const decoded = Buffer.from(payload, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === payload;
  } catch {
    return false;
  }
}

/** Le domaine rend impossible une collision de registre avec les tickets v1 ou de reprise. */
export function hashMistralConversationBootstrapTicket(ticket: string): string {
  return createHash('sha256')
    .update(TICKET_HASH_DOMAIN, 'utf8')
    .update(ticket, 'utf8')
    .digest('hex');
}

export interface MistralConversationBootstrapTicketIssueInput {
  /** Capacité réellement réservée par l'autorité provider-neutral ; l'adapter la relit sous lock. */
  readonly lease: RealtimeAdmissionLease;
  /** Chiffré au repos ; jamais rendu au mobile ni ajouté au grant durable. */
  readonly userId: string;
  readonly subjectKeyVersion: number;
  readonly plan: PlanTier;
  readonly contextSchemaVersion: 1;
  readonly contextRevision: number;
  /** Donnée non fiable, recanonisée avant toute écriture. */
  readonly context: unknown;
}

export interface MistralConversationBootstrapTicketBootstrap {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  readonly ticketExpiresAt: string;
  readonly hardExpiresAt: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly routeMode: 'push_to_talk';
  readonly fullDuplexCertified: false;
  readonly maxMissionAudioBytes: number;
}

export type MistralConversationBootstrapTicketIssueResult =
  | {
      readonly status: 'issued';
      readonly bootstrap: MistralConversationBootstrapTicketBootstrap;
    }
  | { readonly status: 'invalid' | 'expired' | 'quota' | 'unavailable' };

export interface MistralConversationBootstrapTicketAuthority
extends MistralConversationBootstrapAuthority {
  issue(
    input: MistralConversationBootstrapTicketIssueInput,
  ): Promise<MistralConversationBootstrapTicketIssueResult>;
}

/** Composition absente = refus explicite, jamais une autorité mémoire de production. */
export class DisabledMistralConversationBootstrapTicketAuthority
implements MistralConversationBootstrapTicketAuthority {
  async issue(): Promise<MistralConversationBootstrapTicketIssueResult> {
    return { status: 'unavailable' };
  }

  async redeemAndOpenInitial(): Promise<MistralConversationBootstrapOpenResult> {
    return { status: 'unavailable' };
  }
}
