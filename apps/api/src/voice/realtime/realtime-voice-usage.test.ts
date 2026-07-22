import { describe, expect, it, vi } from 'vitest';
import {
  DisabledRealtimeVoiceUsageRepository,
  RealtimeVoiceUsageWriter,
  type RealtimeVoiceUsageRepositoryInput,
  type RealtimeVoiceUsageRepositoryPort,
} from './realtime-voice-usage';

const NOW = Date.parse('2026-07-14T08:00:00.000Z');
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

function validInput() {
  return {
    companyId: 'company-1',
    subjectHash: 'a'.repeat(64),
    subjectKeyVersion: 7,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    plan: 'pro' as const,
    kind: 'stt_seconds' as const,
    source: 'mistral.voxtral.realtime.stt',
    amount: 1.2345674,
    dedupeScope: 'provider-session:final:0',
    occurredAt: '2026-07-14T07:59:59.000Z',
  };
}

describe('RealtimeVoiceUsageWriter', () => {
  it('reste fail-closed en mode mémoire', async () => {
    const repository = new DisabledRealtimeVoiceUsageRepository();
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'u'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );
    await expect(writer.record(validInput())).resolves.toEqual({ status: 'unavailable' });
    await expect(writer.recordBatch([validInput(), validInput()]))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('canonise, versionne et HMACe une mesure sans persister la portée brute', async () => {
    const record = vi.fn(async (input: RealtimeVoiceUsageRepositoryInput) => ({
      status: 'recorded' as const,
      eventId: input.eventId,
    }));
    const repository: RealtimeVoiceUsageRepositoryPort = { record };
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 11 },
      () => NOW,
      () => EVENT_ID,
    );

    await expect(writer.record(validInput())).resolves.toEqual({ status: 'recorded', eventId: EVENT_ID });
    expect(record).toHaveBeenCalledOnce();
    const persisted = record.mock.calls[0]![0];
    expect(persisted).toMatchObject({
      subjectKeyVersion: 7,
      proofKeyVersion: 11,
      amount: '1.234567',
      occurredAt: '2026-07-14T07:59:59.000Z',
      recordedAt: '2026-07-14T08:00:00.000Z',
      retentionExpiresAt: '2026-08-13T08:00:00.000Z',
    });
    expect(persisted.dedupeKeyHmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(persisted)).not.toContain(validInput().dedupeScope);
  });

  it('produit la même clé d’idempotence pour un retry mais une autre clé par dimension', async () => {
    const keys: string[] = [];
    const repository: RealtimeVoiceUsageRepositoryPort = {
      record: vi.fn(async (input) => {
        keys.push(input.dedupeKeyHmac);
        return { status: 'recorded' as const, eventId: input.eventId };
      }),
    };
    let counter = 3;
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => `${counter++}3333333-3333-4333-8333-333333333333`,
    );

    await writer.record(validInput());
    await writer.record(validInput());
    await writer.record({ ...validInput(), kind: 'realtime_tokens_in' });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    { amount: 0.0000005, expected: '0.000001' },
    { amount: 1_000_000_000_000, expected: '1000000000000.000000' },
  ])('arrondit exactement à six décimales sans dépasser la précision sûre de Number %#', async ({
    amount,
    expected,
  }) => {
    const record = vi.fn(async (input: RealtimeVoiceUsageRepositoryInput) => ({
      status: 'recorded' as const,
      eventId: input.eventId,
    }));
    const writer = new RealtimeVoiceUsageWriter(
      { record },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );

    await expect(writer.record({ ...validInput(), amount })).resolves.toMatchObject({ status: 'recorded' });
    expect(record.mock.calls[0]![0].amount).toBe(expected);
  });

  it.each([
    { amount: Number.NaN },
    { amount: -1 },
    { amount: 1_000_000_000_001 },
    { subjectKeyVersion: 0 },
    { source: 'mistral provider' },
    { dedupeScope: 'x'.repeat(513) },
    { occurredAt: '2026-07-12T08:00:00.000Z' },
  ])('rejette avant persistance une mesure hostile %#', async (patch) => {
    const repository: RealtimeVoiceUsageRepositoryPort = { record: vi.fn() };
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );
    await expect(writer.record({ ...validInput(), ...patch })).resolves.toEqual({ status: 'rejected' });
    expect(repository.record).not.toHaveBeenCalled();
  });

  it('rejette un événement sans horodatage stable à la frontière runtime', async () => {
    const repository: RealtimeVoiceUsageRepositoryPort = { record: vi.fn() };
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );
    const { occurredAt: _occurredAt, ...hostile } = validInput();
    await expect(writer.record(hostile as unknown as ReturnType<typeof validInput>))
      .resolves.toEqual({ status: 'rejected' });
    expect(repository.record).not.toHaveBeenCalled();
  });

  it('rejette sans lever une horloge hors de la plage Date', async () => {
    const repository: RealtimeVoiceUsageRepositoryPort = { record: vi.fn() };
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => Number.MAX_SAFE_INTEGER,
      () => EVENT_ID,
    );
    await expect(writer.record(validInput())).resolves.toEqual({ status: 'rejected' });
    expect(repository.record).not.toHaveBeenCalled();
  });

  it('dégrade une panne du générateur d’identifiants sans appeler le dépôt', async () => {
    const repository: RealtimeVoiceUsageRepositoryPort = { record: vi.fn() };
    const writer = new RealtimeVoiceUsageWriter(
      repository,
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => { throw new Error('entropy unavailable'); },
    );
    await expect(writer.record(validInput())).resolves.toEqual({ status: 'unavailable' });
    expect(repository.record).not.toHaveBeenCalled();
  });

  it('dégrade toute exception du dépôt en indisponibilité stable', async () => {
    const writer = new RealtimeVoiceUsageWriter(
      { record: async () => { throw new Error('db secret'); } },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );
    await expect(writer.record(validInput())).resolves.toEqual({ status: 'unavailable' });
  });

  it('prépare et confie toutes les dimensions à un seul batch repository', async () => {
    const eventIds = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const record = vi.fn<RealtimeVoiceUsageRepositoryPort['record']>();
    const recordBatch = vi.fn<NonNullable<RealtimeVoiceUsageRepositoryPort['recordBatch']>>()
      .mockImplementation(async (inputs) => ({
        status: 'recorded',
        eventIds: inputs.map((input) => input.eventId),
      }));
    const writer = new RealtimeVoiceUsageWriter(
      { record, recordBatch },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 9 },
      () => NOW,
      () => eventIds.shift()!,
    );

    await expect(writer.recordBatch([
      { ...validInput(), kind: 'realtime_tokens_in', amount: 12 },
      { ...validInput(), kind: 'realtime_tokens_out', amount: 8 },
    ])).resolves.toEqual({
      status: 'recorded',
      eventIds: [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ],
    });

    expect(record).not.toHaveBeenCalled();
    expect(recordBatch).toHaveBeenCalledOnce();
    const persisted = recordBatch.mock.calls[0]![0];
    expect(persisted).toHaveLength(2);
    expect(persisted.map((measure) => measure.recordedAt))
      .toEqual(['2026-07-14T08:00:00.000Z', '2026-07-14T08:00:00.000Z']);
    expect(persisted[0]!.dedupeKeyHmac).not.toBe(persisted[1]!.dedupeKeyHmac);
  });

  it('valide le lot entier avant persistance et refuse un mélange de tenants', async () => {
    const recordBatch = vi.fn<NonNullable<RealtimeVoiceUsageRepositoryPort['recordBatch']>>();
    const ids = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const writer = new RealtimeVoiceUsageWriter(
      { record: vi.fn(), recordBatch },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => ids.shift()!,
    );

    await expect(writer.recordBatch([
      validInput(),
      { ...validInput(), amount: Number.NaN },
    ])).resolves.toEqual({ status: 'rejected' });
    await expect(writer.recordBatch([
      validInput(),
      { ...validInput(), companyId: 'company-2' },
    ])).resolves.toEqual({ status: 'rejected' });
    expect(recordBatch).not.toHaveBeenCalled();
  });

  it('ne retombe jamais vers record lorsque le repository ne sait pas committer atomiquement', async () => {
    const record = vi.fn<RealtimeVoiceUsageRepositoryPort['record']>();
    const writer = new RealtimeVoiceUsageWriter(
      { record },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => EVENT_ID,
    );

    await expect(writer.recordBatch([validInput(), validInput()]))
      .resolves.toEqual({ status: 'unavailable' });
    expect(record).not.toHaveBeenCalled();
  });

  it('ne contacte pas le repository si l’entropie casse au milieu de la préparation', async () => {
    const recordBatch = vi.fn<NonNullable<RealtimeVoiceUsageRepositoryPort['recordBatch']>>();
    let calls = 0;
    const writer = new RealtimeVoiceUsageWriter(
      { record: vi.fn(), recordBatch },
      { proofSecret: 'p'.repeat(32), proofKeyVersion: 1 },
      () => NOW,
      () => {
        calls += 1;
        if (calls === 2) throw new Error('entropy unavailable');
        return EVENT_ID;
      },
    );

    await expect(writer.recordBatch([validInput(), validInput()]))
      .resolves.toEqual({ status: 'unavailable' });
    expect(recordBatch).not.toHaveBeenCalled();
  });
});
