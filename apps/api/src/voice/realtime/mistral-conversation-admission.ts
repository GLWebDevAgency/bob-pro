import {
  isRealtimeCompanyId,
  isRealtimeSessionId,
  isRealtimeSubjectHash,
} from './realtime-admission';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const PROVIDER_CALL = /^mcv2:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const INT32_MAX = 0x7fff_ffff;

export interface MistralConversationAdmissionPolicy {
  /** Durée glissante d'un owner vivant ; toujours bornée par le hard cap de la Mission. */
  readonly activeLeaseSeconds: number;
  /** Fréquence du heartbeat owner-fencé. Doit rester strictement inférieure au lease actif. */
  readonly heartbeatSeconds: number;
}

export const DEFAULT_MISTRAL_CONVERSATION_ADMISSION_POLICY:
MistralConversationAdmissionPolicy = Object.freeze({
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
});

export function validateMistralConversationAdmissionPolicy(
  policy: MistralConversationAdmissionPolicy,
): void {
  if (
    !Number.isSafeInteger(policy.activeLeaseSeconds)
    || policy.activeLeaseSeconds < 20
    || policy.activeLeaseSeconds > 120
    || !Number.isSafeInteger(policy.heartbeatSeconds)
    || policy.heartbeatSeconds < 5
    || policy.heartbeatSeconds >= policy.activeLeaseSeconds
  ) throw new Error('Invalid Mistral conversation admission policy.');
}

/** Namespace réservé au routeur de terminaison Mistral : jamais un id de session Voxtral v1. */
export function mistralConversationProviderCallId(bootstrapId: string): string | null {
  const canonical = bootstrapId.toLowerCase();
  return UUID.test(canonical) ? `mcv2:${canonical}` : null;
}

export function parseMistralConversationProviderCallId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = PROVIDER_CALL.exec(value);
  return match?.[1] ?? null;
}

export interface MistralConversationAdmissionOwner {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly admissionSessionId: string;
  readonly sessionHandle: string;
  readonly bootstrapId: string;
  readonly missionConnectionEpoch: number;
  /** Secret process-local ; seule son empreinte existe dans la Mission. */
  readonly ownerLeaseToken: string;
}

export function isMistralConversationAdmissionOwner(
  input: MistralConversationAdmissionOwner,
): boolean {
  return isRealtimeCompanyId(input.companyId)
    && isRealtimeSubjectHash(input.subjectHash)
    && isRealtimeSessionId(input.admissionSessionId)
    && input.sessionHandle === input.admissionSessionId.toLowerCase()
    && UUID.test(input.bootstrapId)
    && mistralConversationProviderCallId(input.bootstrapId) !== null
    && Number.isSafeInteger(input.missionConnectionEpoch)
    && input.missionConnectionEpoch >= 1
    && input.missionConnectionEpoch <= INT32_MAX
    && OWNER_TOKEN.test(input.ownerLeaseToken);
}

export type MistralConversationAdmissionRenewResult =
  | { readonly status: 'renewed'; readonly leaseExpiresAt: string }
  | { readonly status: 'stale_owner' | 'closed' | 'expired' | 'aborted' | 'unavailable' };

export type MistralConversationAdmissionReleaseResult =
  | { readonly status: 'released' | 'replayed' }
  | { readonly status: 'stale_owner' | 'not_closed' | 'aborted' | 'unavailable' };

/**
 * Autorité de session v2. Le token brut du bail d'admission n'est jamais restitué au gateway :
 * chaque mutation est autorisée par l'owner durable de la Mission et son epoch.
 */
export interface MistralConversationAdmissionAuthority {
  readonly policy: MistralConversationAdmissionPolicy;
  renewOwner(
    input: MistralConversationAdmissionOwner & { readonly signal: AbortSignal },
  ): Promise<MistralConversationAdmissionRenewResult>;
  releaseClosed(
    input: MistralConversationAdmissionOwner & { readonly signal: AbortSignal },
  ): Promise<MistralConversationAdmissionReleaseResult>;
}

export class DisabledMistralConversationAdmissionAuthority
implements MistralConversationAdmissionAuthority {
  readonly policy: MistralConversationAdmissionPolicy = Object.freeze({
    ...DEFAULT_MISTRAL_CONVERSATION_ADMISSION_POLICY,
  });

  async renewOwner(): Promise<MistralConversationAdmissionRenewResult> {
    return { status: 'unavailable' };
  }

  async releaseClosed(): Promise<MistralConversationAdmissionReleaseResult> {
    return { status: 'unavailable' };
  }
}
