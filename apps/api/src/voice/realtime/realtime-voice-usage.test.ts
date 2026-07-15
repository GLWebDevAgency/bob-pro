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
});
