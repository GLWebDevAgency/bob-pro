import type { PlanTier } from '@bob/core';
import type {
  OpenAiNativeResponseUsageInput,
  OpenAiNativeResponseUsagePort,
  OpenAiNativeResponseUsageResult,
} from './openai-native-response-dispatcher';
import type {
  RealtimeVoiceUsageBatchWriteResult,
  RealtimeVoiceUsageInput,
  RealtimeVoiceUsageWriterPort,
} from './realtime-voice-usage';

const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_PROVIDER_TOKEN_COUNT = 1_000_000_000;
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

export const OPENAI_NATIVE_RESPONSE_USAGE_SOURCE = 'openai.realtime.native.response' as const;

export interface OpenAiNativeResponseUsageContext {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly sessionId: string;
  readonly plan: PlanTier;
  /**
   * Horodatage de création de la réponse, capturé une fois par l'appelant. Il ne doit jamais être
   * recalculé lors d'une réconciliation : le dépôt compare cette valeur sur les retries.
   */
  readonly occurredAt: string;
}

type UsageMeasure = Pick<RealtimeVoiceUsageInput, 'kind' | 'amount'>;

export const OPENAI_NATIVE_RESPONSE_USAGE_MEASURE_KINDS = Object.freeze([
  'realtime_uncached_text_tokens_in',
  'realtime_uncached_audio_tokens_in',
  'realtime_uncached_image_tokens_in',
  'realtime_cached_text_tokens_in',
  'realtime_cached_audio_tokens_in',
  'realtime_cached_image_tokens_in',
  'realtime_text_tokens_out',
  'realtime_audio_tokens_out',
] as const satisfies readonly RealtimeVoiceUsageInput['kind'][]);

function isCanonicalIso(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validPositivePostgresInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validContext(value: unknown): value is OpenAiNativeResponseUsageContext {
  if (typeof value !== 'object' || value === null) return false;
  const context = value as Partial<OpenAiNativeResponseUsageContext>;
  return typeof context.companyId === 'string'
    && COMPANY_ID.test(context.companyId)
    && typeof context.subjectHash === 'string'
    && SHA256_HEX.test(context.subjectHash)
    && typeof context.subjectKeyVersion === 'number'
    && validPositivePostgresInt(context.subjectKeyVersion)
    && typeof context.sessionId === 'string'
    && UUID.test(context.sessionId)
    && typeof context.plan === 'string'
    && PLANS.has(context.plan)
    && typeof context.occurredAt === 'string'
    && isCanonicalIso(context.occurredAt);
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_PROVIDER_TOKEN_COUNT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRuntimeBinding(
  value: unknown,
  context: OpenAiNativeResponseUsageContext,
): value is OpenAiNativeResponseUsageInput {
  if (!isRecord(value)) return false;
  const input = value as Partial<OpenAiNativeResponseUsageInput>;
  if (input.provider !== 'openai' || input.companyId !== context.companyId) return false;
  return typeof input.deliveryId === 'string'
    && UUID.test(input.deliveryId)
    && typeof input.sessionId === 'string'
    && input.sessionId.toLowerCase() === context.sessionId
    && typeof input.turnId === 'string'
    && UUID.test(input.turnId)
    && isRecord(input.usage);
}

function exactCostMeasures(
  value: unknown,
): readonly UsageMeasure[] | null {
  if (!isRecord(value) || value.status !== 'available') return null;
  const totalTokens = value.totalTokens;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (
    !validTokenCount(totalTokens)
    || !validTokenCount(inputTokens)
    || !validTokenCount(outputTokens)
    || totalTokens !== inputTokens + outputTokens
    || !isRecord(value.inputTokenDetails)
    || !isRecord(value.outputTokenDetails)
  ) return null;

  const input = value.inputTokenDetails;
  const output = value.outputTokenDetails;
  const cachedTokens = input.cachedTokens;
  const textTokens = input.textTokens;
  const audioTokens = input.audioTokens;
  const imageTokens = input.imageTokens;
  const cachedTextTokens = input.cachedTextTokens;
  const cachedAudioTokens = input.cachedAudioTokens;
  const cachedImageTokens = input.cachedImageTokens;
  const outputTextTokens = output.textTokens;
  const outputAudioTokens = output.audioTokens;
  if (
    !validTokenCount(cachedTokens)
    || !validTokenCount(textTokens)
    || !validTokenCount(audioTokens)
    || !validTokenCount(imageTokens)
    || !validTokenCount(cachedTextTokens)
    || !validTokenCount(cachedAudioTokens)
    || !validTokenCount(cachedImageTokens)
    || !validTokenCount(outputTextTokens)
    || !validTokenCount(outputAudioTokens)
    || textTokens + audioTokens + imageTokens !== inputTokens
    || cachedTextTokens + cachedAudioTokens + cachedImageTokens !== cachedTokens
    || cachedTextTokens > textTokens
    || cachedAudioTokens > audioTokens
    || cachedImageTokens > imageTokens
    || outputTextTokens + outputAudioTokens !== outputTokens
  ) return null;

  return Object.freeze([
    Object.freeze({
      kind: 'realtime_uncached_text_tokens_in',
      amount: textTokens - cachedTextTokens,
    }),
    Object.freeze({
      kind: 'realtime_uncached_audio_tokens_in',
      amount: audioTokens - cachedAudioTokens,
    }),
    Object.freeze({
      kind: 'realtime_uncached_image_tokens_in',
      amount: imageTokens - cachedImageTokens,
    }),
    Object.freeze({ kind: 'realtime_cached_text_tokens_in', amount: cachedTextTokens }),
    Object.freeze({ kind: 'realtime_cached_audio_tokens_in', amount: cachedAudioTokens }),
    Object.freeze({ kind: 'realtime_cached_image_tokens_in', amount: cachedImageTokens }),
    Object.freeze({ kind: 'realtime_text_tokens_out', amount: outputTextTokens }),
    Object.freeze({ kind: 'realtime_audio_tokens_out', amount: outputAudioTokens }),
  ] satisfies readonly UsageMeasure[]);
}

function usageResult(result: unknown): OpenAiNativeResponseUsageResult {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return { status: 'unavailable' };
  }
  const status = (result as Partial<RealtimeVoiceUsageBatchWriteResult>).status;
  switch (status) {
    case 'recorded':
    case 'duplicate': {
      const eventIds = 'eventIds' in result && Array.isArray(result.eventIds)
        ? result.eventIds
        : null;
      if (
        eventIds === null
        || eventIds.length !== OPENAI_NATIVE_RESPONSE_USAGE_MEASURE_KINDS.length
        || eventIds.some((eventId) => typeof eventId !== 'string' || !UUID.test(eventId))
        || new Set(eventIds).size !== eventIds.length
      ) return { status: 'unavailable' };
      return { status };
    }
    case 'rejected':
      return { status: 'rejected' };
    case 'conflict':
      return { status: 'conflict' };
    case 'unavailable':
      return { status: 'unavailable' };
    default:
      return { status: 'unavailable' };
  }
}

/**
 * Adaptateur étroit entre les compteurs OpenAI déjà décodés et le journal provider-neutre.
 *
 * Le contexte pseudonymisé est figé à la construction. Une mesure ne transporte que des UUID,
 * huit compteurs non chevauchants et une source constante ; aucun transcript, audio, nom ou
 * payload fournisseur ne traverse cette frontière.
 */
export class OpenAiNativeResponseUsageAdapter implements OpenAiNativeResponseUsagePort {
  private readonly context: Readonly<OpenAiNativeResponseUsageContext>;
  private readonly writeBatch: NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']>;

  constructor(
    writer: RealtimeVoiceUsageWriterPort,
    context: OpenAiNativeResponseUsageContext,
  ) {
    if (
      !writer
      || typeof writer.recordBatch !== 'function'
      || !validContext(context)
    ) throw new Error('openai_native_response_usage_configuration_invalid');
    this.writeBatch = writer.recordBatch.bind(writer);
    this.context = Object.freeze({
      companyId: context.companyId,
      subjectHash: context.subjectHash,
      subjectKeyVersion: context.subjectKeyVersion,
      sessionId: context.sessionId.toLowerCase(),
      plan: context.plan,
      occurredAt: context.occurredAt,
    });
  }

  async record(input: OpenAiNativeResponseUsageInput): Promise<OpenAiNativeResponseUsageResult> {
    if (!validRuntimeBinding(input, this.context)) return { status: 'rejected' };
    const measures = exactCostMeasures(input.usage);
    if (measures === null) return { status: 'rejected' };

    const deliveryId = input.deliveryId.toLowerCase();
    const common = Object.freeze({
      companyId: this.context.companyId,
      subjectHash: this.context.subjectHash,
      subjectKeyVersion: this.context.subjectKeyVersion,
      sessionId: this.context.sessionId,
      turnId: input.turnId.toLowerCase(),
      plan: this.context.plan,
      source: OPENAI_NATIVE_RESPONSE_USAGE_SOURCE,
      // `kind` est une dimension distincte de la HMAC du writer : cette portée reste donc commune
      // aux huit compteurs tout en produisant huit clés d'idempotence séparées et stables.
      dedupeScope: `openai-native-response:${deliveryId}`,
      occurredAt: this.context.occurredAt,
    });
    try {
      return usageResult(await this.writeBatch(
        Object.freeze(measures.map((measure) => Object.freeze({ ...common, ...measure }))),
      ));
    } catch {
      return { status: 'unavailable' };
    }
  }
}
