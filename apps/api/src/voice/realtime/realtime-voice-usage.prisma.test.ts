import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeVoiceUsageRepository } from './realtime-voice-usage.prisma';
import type { RealtimeVoiceUsageRepositoryInput } from './realtime-voice-usage';

const COMPANY_ID = 'company-1';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const EXISTING_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_HASH = 'a'.repeat(64);
const DEDUPE_HMAC = 'b'.repeat(64);

function validInput(
  overrides: Partial<RealtimeVoiceUsageRepositoryInput> = {},
): RealtimeVoiceUsageRepositoryInput {
  return {
    eventId: EVENT_ID,
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    dedupeKeyHmac: DEDUPE_HMAC,
    proofKeyVersion: 11,
    plan: 'pro',
    kind: 'stt_seconds',
    source: 'mistral.voxtral.realtime.stt',
    amount: '1.234567',
    occurredAt: '2026-07-14T07:59:59.000Z',
    recordedAt: '2026-07-14T08:00:00.000Z',
    retentionExpiresAt: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

function existingRow(
  input: RealtimeVoiceUsageRepositoryInput,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: EXISTING_EVENT_ID,
    companyId: input.companyId,
    subjectHash: input.subjectHash,
    subjectKeyVersion: input.subjectKeyVersion,
    sessionId: input.sessionId,
    turnId: input.turnId,
    dedupeKeyHmac: input.dedupeKeyHmac,
    proofKeyVersion: input.proofKeyVersion,
    plan: input.plan,
    kind: input.kind,
    source: input.source,
    amount: new Prisma.Decimal(input.amount),
    occurredAt: new Date(input.occurredAt),
    ...overrides,
  };
}

type QueryMock = ReturnType<typeof vi.fn>;

function repository(results: readonly unknown[]) {
  const queue = [...results];
  const queryRaw = vi.fn(async () => {
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  const isolatedErrors: unknown[] = [];
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    try {
      return await operation(tx);
    } catch (error) {
      isolatedErrors.push(error);
      throw error;
    }
  });
  return {
    value: new PrismaRealtimeVoiceUsageRepository({
      withTenant,
      withIsolatedTenant,
    } as unknown as PrismaService),
    queryRaw,
    withTenant,
    withIsolatedTenant,
    isolatedErrors,
  };
}

function sqlAt(queryRaw: QueryMock, index: number): string {
  const strings = queryRaw.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

describe('PrismaRealtimeVoiceUsageRepository', () => {
  it('insère par SQL paramétré dans une transaction RLS tenant', async () => {
    const input = validInput();
    const h = repository([[{ id: EVENT_ID }]]);

    await expect(h.value.record(input)).resolves.toEqual({ status: 'recorded', eventId: EVENT_ID });
    expect(h.withTenant).toHaveBeenCalledWith(COMPANY_ID, expect.any(Function));
    expect(h.queryRaw).toHaveBeenCalledOnce();
    expect(sqlAt(h.queryRaw, 0)).toContain('ON CONFLICT ("companyId", "dedupeKeyHmac") DO NOTHING');
    expect(sqlAt(h.queryRaw, 0)).not.toContain(COMPANY_ID);
    expect(h.queryRaw.mock.calls[0]?.slice(1)).toEqual([
      EVENT_ID,
      COMPANY_ID,
      SUBJECT_HASH,
      7,
      SESSION_ID,
      TURN_ID,
      DEDUPE_HMAC,
      11,
      'pro',
      'stt_seconds',
      'mistral.voxtral.realtime.stt',
      '1.234567',
      new Date('2026-07-14T07:59:59.000Z'),
      new Date('2026-07-14T08:00:00.000Z'),
      new Date('2026-08-13T08:00:00.000Z'),
    ]);
  });

  it('reconnaît un retry sémantiquement identique même si sa fenêtre de rétention a avancé', async () => {
    const input = validInput({
      recordedAt: '2026-07-14T08:01:00.000Z',
      retentionExpiresAt: '2026-08-13T08:01:00.000Z',
    });
    const h = repository([[], [existingRow(input)]]);

    await expect(h.value.record(input)).resolves.toEqual({
      status: 'duplicate',
      eventId: EXISTING_EVENT_ID,
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlAt(h.queryRaw, 1)).not.toContain('retentionExpiresAt');
  });

  it('signale une collision de clé lorsque la quantité immuable diffère', async () => {
    const input = validInput();
    const h = repository([[], [existingRow(input, { amount: new Prisma.Decimal('2.000000') })]]);

    await expect(h.value.record(input)).resolves.toEqual({ status: 'conflict' });
  });

  it('échoue fermé avant la transaction pour une entrée invalide', async () => {
    const h = repository([]);

    await expect(h.value.record(validInput({ dedupeKeyHmac: 'raw-provider-event-id' })))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(h.value.record({
      ...validInput(),
      companyId: Symbol('hostile-company'),
    } as unknown as RealtimeVoiceUsageRepositoryInput)).resolves.toEqual({ status: 'unavailable' });
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('masque les erreurs SQL et ne propage aucun détail du stockage', async () => {
    const h = repository([new Error('postgres connection secret')]);

    await expect(h.value.record(validInput())).resolves.toEqual({ status: 'unavailable' });
  });

  it('committe les deux mesures dans une unique transaction tenantée isolée', async () => {
    const first = validInput();
    const second = validInput({
      eventId: '55555555-5555-4555-8555-555555555555',
      dedupeKeyHmac: 'c'.repeat(64),
      kind: 'realtime_tokens_out',
      amount: '8.000000',
    });
    const h = repository([
      [{ id: first.eventId }],
      [{ id: second.eventId }],
    ]);

    await expect(h.value.recordBatch([first, second])).resolves.toEqual({
      status: 'recorded',
      eventIds: [first.eventId, second.eventId],
    });
    expect(h.withIsolatedTenant).toHaveBeenCalledOnce();
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(COMPANY_ID, expect.any(Function));
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('retourne duplicate uniquement quand le lot entier est déjà durable et identique', async () => {
    const first = validInput();
    const second = validInput({
      eventId: '55555555-5555-4555-8555-555555555555',
      dedupeKeyHmac: 'c'.repeat(64),
      kind: 'realtime_tokens_out',
      amount: '8.000000',
    });
    const firstExisting = existingRow(first);
    const secondExisting = existingRow(second, { id: '66666666-6666-4666-8666-666666666666' });
    const h = repository([[], [firstExisting], [], [secondExisting]]);

    await expect(h.value.recordBatch([first, second])).resolves.toEqual({
      status: 'duplicate',
      eventIds: [EXISTING_EVENT_ID, '66666666-6666-4666-8666-666666666666'],
    });
  });

  it('annule le lot entier en levant dans la transaction dès qu’une collision diffère', async () => {
    const first = validInput();
    const second = validInput({
      eventId: '55555555-5555-4555-8555-555555555555',
      dedupeKeyHmac: 'c'.repeat(64),
      kind: 'realtime_tokens_out',
      amount: '8.000000',
    });
    const h = repository([
      [{ id: first.eventId }],
      [],
      [existingRow(second, { amount: new Prisma.Decimal('9.000000') })],
    ]);

    await expect(h.value.recordBatch([first, second])).resolves.toEqual({ status: 'conflict' });
    expect(h.withIsolatedTenant).toHaveBeenCalledOnce();
    expect(h.queryRaw).toHaveBeenCalledTimes(3);
    expect(h.isolatedErrors).toHaveLength(1);
    expect(h.isolatedErrors[0]).toMatchObject({ message: 'realtime_voice_usage_batch_conflict' });
  });

  it('dégrade une panne de seconde insertion après avoir forcé le rollback transactionnel', async () => {
    const first = validInput();
    const second = validInput({
      eventId: '55555555-5555-4555-8555-555555555555',
      dedupeKeyHmac: 'c'.repeat(64),
      kind: 'realtime_tokens_out',
    });
    const h = repository([[{ id: first.eventId }], new Error('postgres connection secret')]);

    await expect(h.value.recordBatch([first, second])).resolves.toEqual({ status: 'unavailable' });
    expect(h.withIsolatedTenant).toHaveBeenCalledOnce();
  });

  it('refuse tout lot invalide ou multi-tenant avant d’ouvrir la transaction', async () => {
    const h = repository([]);

    await expect(h.value.recordBatch([])).resolves.toEqual({ status: 'unavailable' });
    await expect(h.value.recordBatch([
      validInput(),
      validInput({ companyId: 'company-2', dedupeKeyHmac: 'c'.repeat(64) }),
    ])).resolves.toEqual({ status: 'unavailable' });
    await expect(h.value.recordBatch([
      validInput(),
      validInput({ dedupeKeyHmac: 'raw-provider-event-id' }),
    ])).resolves.toEqual({ status: 'unavailable' });
    expect(h.withIsolatedTenant).not.toHaveBeenCalled();
  });
});
