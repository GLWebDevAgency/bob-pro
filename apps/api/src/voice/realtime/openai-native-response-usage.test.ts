import type { PlanTier } from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import type { OpenAiNativeResponseUsageInput } from './openai-native-response-dispatcher';
import {
  OPENAI_NATIVE_RESPONSE_USAGE_SOURCE,
  OpenAiNativeResponseUsageAdapter,
  type OpenAiNativeResponseUsageContext,
} from './openai-native-response-usage';
import {
  RealtimeVoiceUsageWriter,
  type RealtimeVoiceUsageRepositoryInput,
  type RealtimeVoiceUsageRepositoryPort,
  type RealtimeVoiceUsageWriterPort,
} from './realtime-voice-usage';

const COMPANY_ID = 'company-1';
const SUBJECT_HASH = 'a'.repeat(64);
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const DELIVERY_ID = '33333333-3333-4333-8333-333333333333';
const OCCURRED_AT = '2026-07-22T12:34:56.789Z';

function context(overrides: Partial<OpenAiNativeResponseUsageContext> = {}) {
  return {
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    sessionId: SESSION_ID,
    plan: 'pro' as PlanTier,
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

function input(overrides: Partial<OpenAiNativeResponseUsageInput> = {}) {
  return {
    provider: 'openai' as const,
    companyId: COMPANY_ID,
    deliveryId: DELIVERY_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    usage: {
      status: 'available' as const,
      totalTokens: 20,
      inputTokens: 12,
      outputTokens: 8,
      inputTokenDetails: {
        cachedTokens: 2,
        textTokens: 4,
        audioTokens: 8,
        cachedTextTokens: 1,
        cachedAudioTokens: 1,
      },
      outputTokenDetails: { textTokens: 0, audioTokens: 8 },
    },
    ...overrides,
  };
}

function writer(
  implementation: NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']> = async () => ({
    status: 'recorded',
    eventIds: [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ],
  }),
) {
  const record = vi.fn<RealtimeVoiceUsageWriterPort['record']>();
  const recordBatch = vi.fn<NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']>>()
    .mockImplementation(implementation);
  return {
    port: { record, recordBatch } satisfies RealtimeVoiceUsageWriterPort,
    record,
    recordBatch,
  };
}

describe('OpenAiNativeResponseUsageAdapter', () => {
  it('mappe les deux compteurs avec une identité pseudonymisée, une source et un temps stables', async () => {
    const metering = writer();
    const mutableContext = context();
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, mutableContext);
    mutableContext.companyId = 'company-mutated';
    mutableContext.occurredAt = '2026-07-22T13:00:00.000Z';

    await expect(adapter.record({
      ...input(),
      transcript: 'Client Dupont, facture confidentielle',
      providerPayload: { customerEmail: 'client@example.test' },
    } as unknown as OpenAiNativeResponseUsageInput)).resolves.toEqual({ status: 'recorded' });
    expect(metering.record).not.toHaveBeenCalled();
    expect(metering.recordBatch).toHaveBeenCalledOnce();
    expect(metering.recordBatch).toHaveBeenCalledWith([
      {
        companyId: COMPANY_ID,
        subjectHash: SUBJECT_HASH,
        subjectKeyVersion: 7,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        plan: 'pro',
        source: OPENAI_NATIVE_RESPONSE_USAGE_SOURCE,
        dedupeScope: `openai-native-response:${DELIVERY_ID}`,
        occurredAt: OCCURRED_AT,
        kind: 'realtime_tokens_in',
        amount: 12,
      },
      expect.objectContaining({
        kind: 'realtime_tokens_out',
        amount: 8,
        occurredAt: OCCURRED_AT,
      }),
    ]);
    const serialized = JSON.stringify(metering.recordBatch.mock.calls);
    expect(serialized).not.toContain('cachedTokens');
    expect(serialized).not.toContain('audioTokens');
    expect(serialized).not.toContain('totalTokens');
    expect(serialized).not.toContain('Dupont');
    expect(serialized).not.toContain('client@example.test');
  });

  it('produit deux HMAC distinctes avec le writer réel puis déduplique un retry complet', async () => {
    const rows = new Map<string, RealtimeVoiceUsageRepositoryInput>();
    const persisted: RealtimeVoiceUsageRepositoryInput[] = [];
    const repository: RealtimeVoiceUsageRepositoryPort = {
      record: async () => ({ status: 'unavailable' }),
      recordBatch: async (measurements) => {
        persisted.push(...measurements);
        const existing = measurements.map((measurement) => rows.get(measurement.dedupeKeyHmac));
        if (existing.every(Boolean)) {
          return { status: 'duplicate', eventIds: existing.map((row) => row!.eventId) };
        }
        for (const measurement of measurements) rows.set(measurement.dedupeKeyHmac, measurement);
        return { status: 'recorded', eventIds: measurements.map((measurement) => measurement.eventId) };
      },
    };
    const eventIds = [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ];
    const usageWriter = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 3 },
      () => Date.parse('2026-07-22T12:35:00.000Z'),
      () => eventIds.shift()!,
    );
    const adapter = new OpenAiNativeResponseUsageAdapter(usageWriter, context());

    await expect(adapter.record(input())).resolves.toEqual({ status: 'recorded' });
    await expect(adapter.record(input())).resolves.toEqual({ status: 'duplicate' });

    expect(rows).toHaveLength(2);
    expect(persisted).toHaveLength(4);
    expect(persisted[0]!.dedupeKeyHmac).not.toBe(persisted[1]!.dedupeKeyHmac);
    expect(persisted[0]!.dedupeKeyHmac).toBe(persisted[2]!.dedupeKeyHmac);
    expect(persisted[1]!.dedupeKeyHmac).toBe(persisted[3]!.dedupeKeyHmac);
    expect(JSON.stringify(persisted)).not.toContain(DELIVERY_ID);
  });

  it('rejoue un lot indisponible sans aucune écriture unitaire ni fallback partiel', async () => {
    const outcomes = [
      { status: 'unavailable' as const },
      {
        status: 'recorded' as const,
        eventIds: [
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
        ],
      },
    ];
    const metering = writer(async () => outcomes.shift() ?? { status: 'unavailable' as const });
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());

    await expect(adapter.record(input())).resolves.toEqual({ status: 'unavailable' });
    await expect(adapter.record(input())).resolves.toEqual({ status: 'recorded' });

    expect(metering.record).not.toHaveBeenCalled();
    expect(metering.recordBatch).toHaveBeenCalledTimes(2);
    expect(metering.recordBatch.mock.calls.map(([measures]) => measures.map((measure) => ({
      kind: measure.kind,
      scope: measure.dedupeScope,
      occurredAt: measure.occurredAt,
      amount: measure.amount,
    })))).toEqual([0, 1].map(() => [
      { kind: 'realtime_tokens_in', scope: `openai-native-response:${DELIVERY_ID}`, occurredAt: OCCURRED_AT, amount: 12 },
      { kind: 'realtime_tokens_out', scope: `openai-native-response:${DELIVERY_ID}`, occurredAt: OCCURRED_AT, amount: 8 },
    ]));
  });

  it('retourne duplicate seulement lorsque les deux dimensions existent déjà', async () => {
    const metering = writer(async () => ({
      status: 'duplicate',
      eventIds: [
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
      ],
    }));
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());
    await expect(adapter.record(input())).resolves.toEqual({ status: 'duplicate' });
    expect(metering.recordBatch).toHaveBeenCalledOnce();
  });

  it.each([
    ['provider', { provider: 'mistral' }],
    ['tenant', { companyId: 'company-2' }],
    ['session', { sessionId: '66666666-6666-4666-8666-666666666666' }],
    ['delivery', { deliveryId: 'not-a-uuid' }],
    ['turn', { turnId: 'not-a-uuid' }],
    ['compteurs divergents', { usage: { ...input().usage, totalTokens: 21 } }],
  ])('refuse avant écriture un binding incohérent : %s', async (_label, patch) => {
    const metering = writer();
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());
    await expect(adapter.record(input(patch as Partial<OpenAiNativeResponseUsageInput>)))
      .resolves.toEqual({ status: 'rejected' });
    expect(metering.recordBatch).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'conflict', 'unavailable'] as const)(
    'propage le résultat atomique %s sans écriture unitaire',
    async (status) => {
      const metering = writer(async () => ({ status }));
      const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());
      await expect(adapter.record(input())).resolves.toEqual({ status });
      expect(metering.recordBatch).toHaveBeenCalledOnce();
    },
  );

  it('dégrade une exception du writer sans exposer son message', async () => {
    const metering = writer(async () => { throw new Error('transcript secret'); });
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());
    await expect(adapter.record(input())).resolves.toEqual({ status: 'unavailable' });
  });

  it('dégrade aussi une réponse runtime malformée du writer', async () => {
    const metering = writer(async () => null as unknown as Awaited<
    ReturnType<NonNullable<RealtimeVoiceUsageWriterPort['recordBatch']>>
    >);
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());
    await expect(adapter.record(input())).resolves.toEqual({ status: 'unavailable' });
  });

  it.each([
    ['writer absent', null, context()],
    ['batch atomique absent', { record: vi.fn() }, context()],
    ['subject hash invalide', writer().port, context({ subjectHash: 'raw-user-id' })],
    ['version invalide', writer().port, context({ subjectKeyVersion: 0 })],
    ['session invalide', writer().port, context({ sessionId: 'not-a-uuid' })],
    ['plan invalide', writer().port, context({ plan: 'enterprise' as PlanTier })],
    ['occurredAt non canonique', writer().port, context({ occurredAt: '2026-07-22' })],
  ])('refuse une configuration non prouvable : %s', (_label, metering, usageContext) => {
    expect(() => new OpenAiNativeResponseUsageAdapter(
      metering as RealtimeVoiceUsageWriterPort,
      usageContext,
    )).toThrow('openai_native_response_usage_configuration_invalid');
  });

  it('soumet les deux dimensions dans un unique appel atomique', async () => {
    const metering = writer();
    const adapter = new OpenAiNativeResponseUsageAdapter(metering.port, context());

    await expect(adapter.record(input())).resolves.toEqual({ status: 'recorded' });
    expect(metering.recordBatch).toHaveBeenCalledOnce();
    expect(metering.recordBatch.mock.calls[0]![0].map((measure) => measure.kind)).toEqual([
      'realtime_tokens_in',
      'realtime_tokens_out',
    ]);
  });
});
