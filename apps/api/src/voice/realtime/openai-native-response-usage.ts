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

function validRuntimeInput(
  value: unknown,
  context: OpenAiNativeResponseUsageContext,
): value is OpenAiNativeResponseUsageInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Partial<OpenAiNativeResponseUsageInput>;
  if (
    input.provider !== 'openai'
    || input.companyId !== context.companyId
    || typeof input.deliveryId !== 'string'
    || !UUID.test(input.deliveryId)
    || typeof input.sessionId !== 'string'
    || input.sessionId.toLowerCase() !== context.sessionId
    || typeof input.turnId !== 'string'
    || !UUID.test(input.turnId)
    || typeof input.usage !== 'object'
    || input.usage === null
  ) return false;
  const usage = input.usage as Partial<OpenAiNativeResponseUsageInput['usage']>;
  return usage.status === 'available'
    && validTokenCount(usage.totalTokens)
    && validTokenCount(usage.inputTokens)
    && validTokenCount(usage.outputTokens)
    && usage.totalTokens === usage.inputTokens + usage.outputTokens;
}

function usageResult(result: unknown): OpenAiNativeResponseUsageResult {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return { status: 'unavailable' };
  }
  const status = (result as Partial<RealtimeVoiceUsageBatchWriteResult>).status;
  switch (status) {
    case 'recorded':
    case 'duplicate': {
      if (
        !('eventIds' in result)
        || !Array.isArray(result.eventIds)
        || result.eventIds.length !== 2
        || result.eventIds.some((eventId) => typeof eventId !== 'string' || !UUID.test(eventId))
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
 * deux compteurs et une source constante ; aucun transcript, audio, nom ou payload fournisseur ne
 * traverse cette frontière.
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
    if (!validRuntimeInput(input, this.context)) return { status: 'rejected' };

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
      // aux deux compteurs tout en produisant deux clés d'idempotence séparées et stables.
      dedupeScope: `openai-native-response:${deliveryId}`,
      occurredAt: this.context.occurredAt,
    });
    const measures = Object.freeze<readonly UsageMeasure[]>([
      Object.freeze({ kind: 'realtime_tokens_in', amount: input.usage.inputTokens }),
      Object.freeze({ kind: 'realtime_tokens_out', amount: input.usage.outputTokens }),
    ]);
    try {
      return usageResult(await this.writeBatch(
        Object.freeze(measures.map((measure) => Object.freeze({ ...common, ...measure }))),
      ));
    } catch {
      return { status: 'unavailable' };
    }
  }
}
