import { createHmac, randomUUID } from 'node:crypto';
import type { VoiceUsageKind } from '@bob/ai';
import type { PlanTier } from '@bob/core';

const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const AMOUNT_DECIMAL = /^(?:0|[1-9][0-9]{0,12})\.[0-9]{6}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_AMOUNT_MICROS = 1_000_000_000_000_000_000n;
const MAX_DEDUPE_SCOPE_BYTES = 512;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export const REALTIME_VOICE_USAGE_KINDS = [
  'realtime_audio_in_seconds',
  'realtime_audio_out_seconds',
  'realtime_tokens_in',
  'realtime_tokens_out',
  'llm_tokens_in',
  'llm_tokens_out',
  'stt_seconds',
  'tts_characters',
] as const satisfies readonly VoiceUsageKind[];

const USAGE_KINDS = new Set<VoiceUsageKind>(REALTIME_VOICE_USAGE_KINDS);
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

export interface RealtimeVoiceUsageRepositoryInput {
  readonly eventId: string;
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly dedupeKeyHmac: string;
  readonly proofKeyVersion: number;
  readonly plan: PlanTier;
  readonly kind: VoiceUsageKind;
  readonly source: string;
  /** Quantité décimale canonique, toujours à six décimales. */
  readonly amount: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly retentionExpiresAt: string;
}

export type RealtimeVoiceUsageRepositoryResult =
  | { readonly status: 'recorded'; readonly eventId: string }
  | { readonly status: 'duplicate'; readonly eventId: string }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' };

export interface RealtimeVoiceUsageRepositoryPort {
  record(input: RealtimeVoiceUsageRepositoryInput): Promise<RealtimeVoiceUsageRepositoryResult>;
}

/** Le mode mémoire ne doit jamais simuler un registre d'usage ou de facturation durable. */
export class DisabledRealtimeVoiceUsageRepository implements RealtimeVoiceUsageRepositoryPort {
  async record(_input: RealtimeVoiceUsageRepositoryInput): Promise<RealtimeVoiceUsageRepositoryResult> {
    return { status: 'unavailable' };
  }
}

export interface RealtimeVoiceUsageInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly plan: PlanTier;
  readonly kind: VoiceUsageKind;
  readonly source: string;
  readonly amount: number;
  /** Identité stable de l'événement provider/étape. Elle est HMACée avant la persistance. */
  readonly dedupeScope: string;
  /** Horodatage stable de l'événement. Un retry doit impérativement réutiliser la même valeur. */
  readonly occurredAt: string;
}

export type RealtimeVoiceUsageWriteResult =
  | { readonly status: 'recorded' | 'duplicate'; readonly eventId: string }
  | { readonly status: 'rejected' | 'conflict' | 'unavailable' };

/** Port runtime étroit : les adapters consommateurs n'accèdent jamais au dépôt ni au HMAC. */
export interface RealtimeVoiceUsageWriterPort {
  record(input: RealtimeVoiceUsageInput): Promise<RealtimeVoiceUsageWriteResult>;
}

export interface RealtimeVoiceUsageWriterConfig {
  readonly proofSecret: string;
  readonly proofKeyVersion: number;
}

function validPositivePostgresInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function canonicalAmount(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) return null;
  // Number#toString fournit la représentation décimale ronde-trip la plus courte. La convertir
  // en BigInt avant l'arrondi évite de dépasser MAX_SAFE_INTEGER quand la quantité approche la
  // borne NUMERIC(20,6), sans introduire un second arrondi binaire via `value * 1_000_000`.
  const match = /^(?<whole>[0-9]+)(?:\.(?<fraction>[0-9]+))?(?:e(?<exponent>[+-]?[0-9]+))?$/u
    .exec(value.toString().toLowerCase());
  if (!match?.groups) return null;
  const wholeDigits = match.groups.whole;
  if (wholeDigits === undefined) return null;
  const fraction = match.groups.fraction ?? '';
  const exponent = Number.parseInt(match.groups.exponent ?? '0', 10);
  if (!Number.isSafeInteger(exponent)) return null;
  const digits = BigInt(`${wholeDigits}${fraction}`);
  const decimalShift = exponent - fraction.length + 6;
  let micros: bigint;
  if (decimalShift >= 0) {
    micros = digits * (10n ** BigInt(decimalShift));
  } else {
    const divisor = 10n ** BigInt(-decimalShift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    micros = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  if (micros > MAX_AMOUNT_MICROS) return null;
  const whole = micros / 1_000_000n;
  const microsFraction = micros % 1_000_000n;
  return `${whole}.${microsFraction.toString().padStart(6, '0')}`;
}

function validCanonicalAmount(value: string): boolean {
  if (!AMOUNT_DECIMAL.test(value)) return false;
  return BigInt(value.replace('.', '')) <= MAX_AMOUNT_MICROS;
}

function validIso(value: string): number | null {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? epoch : null;
}

function isoFromEpoch(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isRealtimeVoiceUsageRepositoryInput(
  input: unknown,
): input is RealtimeVoiceUsageRepositoryInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<RealtimeVoiceUsageRepositoryInput>;
  if (
    typeof candidate.eventId !== 'string'
    || typeof candidate.companyId !== 'string'
    || typeof candidate.subjectHash !== 'string'
    || typeof candidate.subjectKeyVersion !== 'number'
    || typeof candidate.sessionId !== 'string'
    || (candidate.turnId !== null && typeof candidate.turnId !== 'string')
    || typeof candidate.dedupeKeyHmac !== 'string'
    || typeof candidate.proofKeyVersion !== 'number'
    || typeof candidate.plan !== 'string'
    || typeof candidate.kind !== 'string'
    || typeof candidate.source !== 'string'
    || typeof candidate.amount !== 'string'
    || typeof candidate.occurredAt !== 'string'
    || typeof candidate.recordedAt !== 'string'
    || typeof candidate.retentionExpiresAt !== 'string'
  ) return false;
  const inputValue = candidate as RealtimeVoiceUsageRepositoryInput;
  const occurredAt = validIso(inputValue.occurredAt);
  const recordedAt = validIso(inputValue.recordedAt);
  const retentionExpiresAt = validIso(inputValue.retentionExpiresAt);
  return UUID.test(inputValue.eventId)
    && COMPANY_ID.test(inputValue.companyId)
    && SHA256_HEX.test(inputValue.subjectHash)
    && validPositivePostgresInt(inputValue.subjectKeyVersion)
    && UUID.test(inputValue.sessionId)
    && (inputValue.turnId === null || UUID.test(inputValue.turnId))
    && SHA256_HEX.test(inputValue.dedupeKeyHmac)
    && validPositivePostgresInt(inputValue.proofKeyVersion)
    && PLANS.has(inputValue.plan)
    && USAGE_KINDS.has(inputValue.kind)
    && SOURCE.test(inputValue.source)
    && validCanonicalAmount(inputValue.amount)
    && occurredAt !== null
    && recordedAt !== null
    && retentionExpiresAt !== null
    && recordedAt >= occurredAt
    && recordedAt <= occurredAt + 24 * 60 * 60 * 1_000
    && retentionExpiresAt > recordedAt
    && retentionExpiresAt <= recordedAt + 36 * 24 * 60 * 60 * 1_000;
}

/**
 * Frontière unique de métrologie Bob Live : aucune donnée vocale ni identifiant utilisateur brut
 * n'est persisté. La clé d'idempotence est HMACée avec séparation de domaine et chaque quantité
 * est figée à six décimales avant d'atteindre PostgreSQL.
 */
export class RealtimeVoiceUsageWriter implements RealtimeVoiceUsageWriterPort {
  constructor(
    private readonly repository: RealtimeVoiceUsageRepositoryPort,
    private readonly config: RealtimeVoiceUsageWriterConfig,
    private readonly now: () => number = Date.now,
    private readonly eventId: () => string = randomUUID,
  ) {
    if (
      Buffer.byteLength(config.proofSecret, 'utf8') < 32
      || !validPositivePostgresInt(config.proofKeyVersion)
    ) throw new Error('realtime_voice_usage_configuration_invalid');
  }

  async record(input: RealtimeVoiceUsageInput): Promise<RealtimeVoiceUsageWriteResult> {
    if (
      typeof input !== 'object'
      || input === null
      || typeof input.companyId !== 'string'
      || typeof input.subjectHash !== 'string'
      || typeof input.subjectKeyVersion !== 'number'
      || typeof input.sessionId !== 'string'
      || (input.turnId !== undefined && typeof input.turnId !== 'string')
      || typeof input.plan !== 'string'
      || typeof input.kind !== 'string'
      || typeof input.source !== 'string'
      || typeof input.amount !== 'number'
      || typeof input.dedupeScope !== 'string'
      || typeof input.occurredAt !== 'string'
    ) return { status: 'rejected' };
    let recordedAtMs: number;
    let generatedEventId: string;
    try {
      recordedAtMs = this.now();
      generatedEventId = this.eventId();
    } catch {
      return { status: 'unavailable' };
    }
    const occurredAtMs = validIso(input.occurredAt);
    const amount = canonicalAmount(input.amount);
    const eventId = typeof generatedEventId === 'string' ? generatedEventId.toLowerCase() : '';
    const sessionId = input.sessionId.toLowerCase();
    const turnId = input.turnId?.toLowerCase() ?? null;
    const recordedAt = isoFromEpoch(recordedAtMs);
    const retentionExpiresAtMs = recordedAtMs + EVENT_RETENTION_MS;
    const retentionExpiresAt = isoFromEpoch(retentionExpiresAtMs);
    if (
      recordedAt === null
      || retentionExpiresAt === null
      || occurredAtMs === null
      || occurredAtMs > recordedAtMs
      || recordedAtMs - occurredAtMs > 24 * 60 * 60 * 1_000
      || amount === null
      || !UUID.test(eventId)
      || !COMPANY_ID.test(input.companyId)
      || !SHA256_HEX.test(input.subjectHash)
      || !validPositivePostgresInt(input.subjectKeyVersion)
      || !UUID.test(sessionId)
      || (input.turnId !== undefined && !UUID.test(turnId ?? ''))
      || !PLANS.has(input.plan)
      || !USAGE_KINDS.has(input.kind)
      || !SOURCE.test(input.source)
      || input.dedupeScope.length === 0
      || Buffer.byteLength(input.dedupeScope, 'utf8') > MAX_DEDUPE_SCOPE_BYTES
      // Une portée contenant un caractère de contrôle est trop facile à construire de manière
      // ambiguë entre adapters. Les espaces et identifiants provider ordinaires restent permis.
      // eslint-disable-next-line no-control-regex
      || /[\u0000-\u001f\u007f]/u.test(input.dedupeScope)
    ) return { status: 'rejected' };

    const dedupeKeyHmac = createHmac('sha256', this.config.proofSecret)
      .update('bob-pro:realtime-voice-usage:dedupe:v1\u0000', 'utf8')
      .update(String(this.config.proofKeyVersion), 'utf8')
      .update('\u0000', 'utf8')
      .update(input.companyId, 'utf8')
      .update('\u0000', 'utf8')
      .update(input.subjectHash, 'utf8')
      .update('\u0000', 'utf8')
      .update(sessionId, 'utf8')
      .update('\u0000', 'utf8')
      .update(turnId ?? '', 'utf8')
      .update('\u0000', 'utf8')
      .update(input.kind, 'utf8')
      .update('\u0000', 'utf8')
      .update(input.source, 'utf8')
      .update('\u0000', 'utf8')
      .update(input.dedupeScope, 'utf8')
      .digest('hex');
    const repositoryInput: RealtimeVoiceUsageRepositoryInput = {
      eventId,
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      subjectKeyVersion: input.subjectKeyVersion,
      sessionId,
      turnId,
      dedupeKeyHmac,
      proofKeyVersion: this.config.proofKeyVersion,
      plan: input.plan,
      kind: input.kind,
      source: input.source,
      amount,
      occurredAt: input.occurredAt,
      recordedAt,
      retentionExpiresAt,
    };
    if (!isRealtimeVoiceUsageRepositoryInput(repositoryInput)) return { status: 'rejected' };

    try {
      return await this.repository.record(repositoryInput);
    } catch {
      return { status: 'unavailable' };
    }
  }
}
