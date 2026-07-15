import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { PlanTier } from '@bob/core';
import type { RealtimeLeaseCredential } from './realtime-admission';
import { MISTRAL_PCM_GATEWAY_PROTOCOL } from './mistral-realtime-gateway';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_SESSION_SECONDS = 900;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

export interface MistralRealtimeIngressTicketPolicy {
  /** Fenêtre très courte pendant laquelle la première trame WSS peut consommer le ticket. */
  ticketTtlSeconds: number;
  /** Fenêtre maximale entre la consommation one-shot et l'enregistrement de la session Mistral. */
  activationTtlSeconds: number;
  /**
   * Fenêtre post-terminaison strictement bornée pendant laquelle l'audio audité peut encore
   * être lu puis acquitté. Elle ne prolonge jamais la borne dure ni le bail de l'owner.
   */
  deliveryGraceSeconds: number;
  /** Conservation bornée de la preuve terminale après la borne dure de session. */
  retentionSeconds: number;
  /** Défense supplémentaire aux quotas d'admission : tickets non terminaux par tenant. */
  maxOutstandingPerTenant: number;
  /** Défense supplémentaire aux quotas d'admission : émissions sur une heure glissante. */
  maxIssuesPerTenantHour: number;
  /** Budget PCM s16le 16 kHz mono, toujours borné à la durée dure réelle du bail. */
  maxAudioBytes: number;
}

export const DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY: MistralRealtimeIngressTicketPolicy = {
  ticketTtlSeconds: 30,
  activationTtlSeconds: 30,
  deliveryGraceSeconds: 300,
  retentionSeconds: 86_400,
  maxOutstandingPerTenant: 25,
  maxIssuesPerTenantHour: 1_000,
  maxAudioBytes: MAX_SESSION_SECONDS * PCM_BYTES_PER_SECOND,
};

export function validateMistralRealtimeIngressTicketPolicy(
  policy: MistralRealtimeIngressTicketPolicy,
): void {
  const integer = (value: number): boolean => Number.isInteger(value);
  if (
    !integer(policy.ticketTtlSeconds)
    || policy.ticketTtlSeconds < 5
    || policy.ticketTtlSeconds > 120
    || !integer(policy.activationTtlSeconds)
    || policy.activationTtlSeconds < 5
    || policy.activationTtlSeconds > 120
    || !integer(policy.deliveryGraceSeconds)
    || policy.deliveryGraceSeconds < 30
    || policy.deliveryGraceSeconds > 300
    || !integer(policy.retentionSeconds)
    || policy.retentionSeconds < 3_600
    || policy.retentionSeconds > 604_800
    || !integer(policy.maxOutstandingPerTenant)
    || policy.maxOutstandingPerTenant < 1
    || policy.maxOutstandingPerTenant > 1_000
    || !integer(policy.maxIssuesPerTenantHour)
    || policy.maxIssuesPerTenantHour < policy.maxOutstandingPerTenant
    || policy.maxIssuesPerTenantHour > 100_000
    || !integer(policy.maxAudioBytes)
    || policy.maxAudioBytes < PCM_BYTES_PER_SECOND
    || policy.maxAudioBytes > MAX_SESSION_SECONDS * PCM_BYTES_PER_SECOND
    || policy.maxAudioBytes % 2 !== 0
  ) {
    throw new Error('Invalid Mistral realtime ingress ticket policy.');
  }
}

export function isMistralRealtimeIngressTicket(ticket: string): boolean {
  if (!TICKET_PATTERN.test(ticket)) return false;
  try {
    const decoded = Buffer.from(ticket, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === ticket;
  } catch {
    return false;
  }
}

export function hashMistralRealtimeIngressTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export interface MistralRealtimeIngressTicketEntropy {
  ticket(): string;
  redemptionId(): string;
}

export const secureMistralRealtimeIngressTicketEntropy: MistralRealtimeIngressTicketEntropy = {
  // 32 octets = 256 bits. La représentation base64url canonique fait exactement 43 caractères.
  ticket: () => randomBytes(32).toString('base64url'),
  redemptionId: randomUUID,
};

export interface MistralRealtimeIngressTicketBootstrap {
  readonly companyId: string;
  readonly sessionId: string;
  readonly ticket: string;
  readonly protocol: typeof MISTRAL_PCM_GATEWAY_PROTOCOL;
  readonly ticketExpiresAt: string;
  readonly hardExpiresAt: string;
  readonly maxAudioBytes: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export type MistralRealtimeIngressTicketIssueResult =
  | { readonly ok: true; readonly bootstrap: MistralRealtimeIngressTicketBootstrap }
  | {
      readonly ok: false;
      readonly reason: 'rejected' | 'expired' | 'quota' | 'unavailable';
    };

export interface MistralRealtimeIngressGrant {
  readonly redemptionId: string;
  readonly companyId: string;
  /** Déchiffré uniquement côté serveur après le CAS one-shot ; jamais sérialisé vers le mobile. */
  readonly userId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: PlanTier;
  readonly sessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly hardExpiresAt: string;
  readonly maxAudioBytes: number;
}

export type MistralRealtimeTicketConsumeResult =
  | { readonly ok: true; readonly grant: MistralRealtimeIngressGrant }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'expired' | 'replayed' | 'unavailable';
    };

export interface MistralRealtimeIngressTicketIssueInput extends RealtimeLeaseCredential {
  readonly userId: string;
  readonly subjectKeyVersion: number;
  readonly plan: PlanTier;
  readonly contextSchemaVersion: 1;
  readonly contextRevision: number;
  /** Entrée non fiable : l'autorité la repasse toujours par parseAgentContext/canonicalisation. */
  readonly context: unknown;
}

export interface MistralRealtimeIngressTicketAuthority {
  issue(input: MistralRealtimeIngressTicketIssueInput): Promise<MistralRealtimeIngressTicketIssueResult>;
  consume(input: {
    /** Localisateur RLS non autorisant, obligatoirement fourni hors URL dans la première trame. */
    readonly companyId: string;
    readonly ticket: string;
    readonly protocol: typeof MISTRAL_PCM_GATEWAY_PROTOCOL;
  }): Promise<MistralRealtimeTicketConsumeResult>;
  bindAndActivate(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerId: 'mistral';
    readonly providerSessionId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'rejected' | 'unavailable' }>;
  abandon(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerSessionId: string | null;
    readonly providerTermination: 'confirmed' | 'not_created' | 'unconfirmed';
  }): Promise<void>;
  complete(input: {
    readonly companyId: string;
    readonly redemptionId: string;
    readonly providerSessionId: string;
    readonly providerTermination: 'confirmed';
  }): Promise<void>;
}

/**
 * Adaptateur fail-closed pour les modes démo/test sans PostgreSQL. Ce n'est pas une autorité
 * mémoire : aucun ticket ne peut y être émis ou consommé et aucun état n'y est conservé.
 */
export class DisabledMistralRealtimeIngressTicketAuthority
implements MistralRealtimeIngressTicketAuthority {
  async issue(): Promise<MistralRealtimeIngressTicketIssueResult> {
    return { ok: false, reason: 'unavailable' };
  }

  async consume(): Promise<MistralRealtimeTicketConsumeResult> {
    return { ok: false, reason: 'unavailable' };
  }

  async bindAndActivate(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' };
  }

  async abandon(): Promise<void> {
    throw new Error('Mistral realtime ingress ticket authority unavailable.');
  }

  async complete(): Promise<void> {
    throw new Error('Mistral realtime ingress ticket authority unavailable.');
  }
}

export const MISTRAL_REALTIME_MAX_CONTEXT_REVISION = POSTGRES_INTEGER_MAX;
export const MISTRAL_REALTIME_PCM_BYTES_PER_SECOND = PCM_BYTES_PER_SECOND;

export interface MistralRealtimeIngressIdentityKeyRing {
  readonly currentVersion: number;
  /** Retourne le secret d'une version autorisée pendant la rotation, sinon null. */
  secret(version: number): string | null;
}

export function validateMistralRealtimeIngressIdentityKeyRing(
  keyRing: MistralRealtimeIngressIdentityKeyRing,
): void {
  let secret: string | null = null;
  try {
    secret = keyRing.secret(keyRing.currentVersion);
  } catch {
    // Normalisé ci-dessous : aucun détail secret/configuration ne sort de la validation.
  }
  if (!validVersion(keyRing.currentVersion) || secret === null || !validSecret(secret)) {
    throw new Error('Invalid Mistral realtime ingress identity key ring.');
  }
}

export interface MistralRealtimeSealedIdentity {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly keyVersion: number;
}

export interface MistralRealtimeIdentityBinding {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly sessionId: string;
  readonly redemptionId: string;
  readonly plan: PlanTier;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

function validSecret(secret: string): boolean {
  return Buffer.byteLength(secret, 'utf8') >= 32
    && !secret.includes('[')
    && !secret.includes(']');
}

function validVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && version <= POSTGRES_INTEGER_MAX;
}

function validUserId(userId: string): boolean {
  if (userId.length < 1 || userId.length > 256 || Buffer.byteLength(userId, 'utf8') > 512) return false;
  for (let index = 0; index < userId.length; index += 1) {
    const code = userId.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function isMistralRealtimeIdentityBinding(binding: MistralRealtimeIdentityBinding): boolean {
  return COMPANY_PATTERN.test(binding.companyId)
    && SHA256_PATTERN.test(binding.subjectHash)
    && validVersion(binding.subjectKeyVersion)
    && UUID_PATTERN.test(binding.sessionId)
    && UUID_PATTERN.test(binding.redemptionId)
    && PLANS.has(binding.plan)
    && validVersion(binding.contextRevision)
    && SHA256_PATTERN.test(binding.contextDigest);
}

function identityAad(binding: MistralRealtimeIdentityBinding, keyVersion: number): Buffer {
  return Buffer.from([
    'bob-pro:mistral-realtime-ingress-identity:aad:v1',
    String(keyVersion),
    binding.companyId,
    binding.subjectHash,
    String(binding.subjectKeyVersion),
    binding.sessionId.toLowerCase(),
    binding.redemptionId.toLowerCase(),
    binding.plan,
    String(binding.contextRevision),
    binding.contextDigest,
  ].join('\u0000'), 'utf8');
}

function identityKey(secret: string, keyVersion: number): Buffer {
  return createHmac('sha256', secret)
    .update(`bob-pro:mistral-realtime-ingress-identity:key:v1\u0000${keyVersion}`, 'utf8')
    .digest();
}

export function sealMistralRealtimeUserIdentity(
  userId: string,
  binding: MistralRealtimeIdentityBinding,
  keyRing: MistralRealtimeIngressIdentityKeyRing,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): MistralRealtimeSealedIdentity {
  const secret = keyRing.secret(keyRing.currentVersion);
  if (
    !validUserId(userId)
    || !isMistralRealtimeIdentityBinding(binding)
    || !validVersion(keyRing.currentVersion)
    || secret === null
    || !validSecret(secret)
  ) throw new Error('Invalid Mistral realtime ingress identity.');
  const nonce = Uint8Array.from(nonceFactory());
  if (nonce.byteLength !== 12) throw new Error('Invalid Mistral realtime ingress identity nonce.');
  const plaintext = Buffer.from(JSON.stringify({ version: 1, userId }), 'utf8');
  const cipher = createCipheriv(
    'aes-256-gcm',
    identityKey(secret, keyRing.currentVersion),
    nonce,
    { authTagLength: 16 },
  );
  cipher.setAAD(identityAad(binding, keyRing.currentVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    tag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: keyRing.currentVersion,
  });
}

export function openMistralRealtimeUserIdentity(
  sealed: MistralRealtimeSealedIdentity,
  binding: MistralRealtimeIdentityBinding,
  keyRing: MistralRealtimeIngressIdentityKeyRing,
): string | null {
  try {
    if (
      !isMistralRealtimeIdentityBinding(binding)
      || !validVersion(sealed.keyVersion)
      || !(sealed.ciphertext instanceof Uint8Array)
      || sealed.ciphertext.byteLength < 1
      || sealed.ciphertext.byteLength > 1_024
      || !(sealed.nonce instanceof Uint8Array)
      || sealed.nonce.byteLength !== 12
      || !(sealed.tag instanceof Uint8Array)
      || sealed.tag.byteLength !== 16
    ) return null;
    const secret = keyRing.secret(sealed.keyVersion);
    if (secret === null || !validSecret(secret)) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      identityKey(secret, sealed.keyVersion),
      sealed.nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(identityAad(binding, sealed.keyVersion));
    decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    if (plaintext.byteLength < 1 || plaintext.byteLength > 1_024) return null;
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2
      || record.version !== 1
      || typeof record.userId !== 'string'
      || !validUserId(record.userId)
    ) return null;
    return record.userId;
  } catch {
    return null;
  }
}
