import { describe, expect, it, vi } from 'vitest';
import type { ResolvedRealtimeVoiceTraceV2Env } from '../../config/env';
import type {
  RealtimeVoiceTraceAppendOutcome,
  RealtimeVoiceTraceAppendStore,
  RealtimeVoiceTraceStoredEvent,
} from './realtime-voice-trace.repository';
import { RealtimeVoiceTraceFactory } from './realtime-voice-trace';

const COMPANY_ID = 'company-1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-08-01T08:00:00.000Z');

function root(fill: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => fill);
}

function config(
  overrides: Partial<ResolvedRealtimeVoiceTraceV2Env> = {},
): ResolvedRealtimeVoiceTraceV2Env {
  const roots = new Map<number, Uint8Array>([
    [1, root(7)],
    [2, root(9)],
  ]);
  return {
    enabled: true,
    subjects: new Set([`${COMPANY_ID}:${USER_ID}`]),
    currentEncryptionVersion: 2,
    encryptionVersions: [1, 2],
    encryptionSecret: (version) => roots.get(version) ?? null,
    ...overrides,
  };
}

function logger() {
  return { error: vi.fn() };
}

function factory(input: {
  readonly append: RealtimeVoiceTraceAppendStore;
  readonly resolved?: ResolvedRealtimeVoiceTraceV2Env;
  readonly log?: ReturnType<typeof logger>;
  readonly attemptId?: () => string;
  readonly eventId?: () => string;
  readonly nonce?: () => Buffer;
  readonly queueCapacity?: number;
}) {
  return new RealtimeVoiceTraceFactory(
    input.append,
    input.resolved ?? config(),
    input.log ?? logger(),
    () => NOW,
    {
      traceAttemptId: input.attemptId ?? (() => ATTEMPT_ID),
      eventId: input.eventId ?? (() => EVENT_ID),
      nonce: input.nonce ?? (() => Buffer.alloc(12, 3)),
    },
    input.queueCapacity,
    [0],
  );
}

function bindAttempt(value: RealtimeVoiceTraceFactory) {
  const attempt = value.begin(COMPANY_ID, USER_ID);
  expect(attempt).not.toBeNull();
  attempt!.bindSession(SESSION_ID);
  attempt!.bindOwner(4);
  return attempt!;
}

function transcriptEvent(text: string) {
  return {
    eventKind: 'turn_transcript_final' as const,
    turnId: TURN_ID,
    stage: 'transcription' as const,
    outcome: 'ready' as const,
    transcript: text,
  };
}

describe('RealtimeVoiceTraceFactory', () => {
  it('ne crée aucun handle ni UUID pour un sujet absent de l’allowlist', () => {
    const traceAttemptId = vi.fn(() => ATTEMPT_ID);
    const append = { assertReady: vi.fn(), append: vi.fn() };
    const value = factory({ append, attemptId: traceAttemptId });

    expect(value.disclosureFor(COMPANY_ID, USER_ID)).toEqual({
      enabled: true,
      retentionDays: 30,
      purpose: 'staging_quality',
    });
    expect(value.begin(COMPANY_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(traceAttemptId).not.toHaveBeenCalled();
    expect(append.append).not.toHaveBeenCalled();
  });

  it('chiffre le transcript avant le port et ne persiste aucun texte clair', async () => {
    const rows: RealtimeVoiceTraceStoredEvent[] = [];
    const append: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(async (row) => {
        rows.push(row);
        return { status: 'inserted' as const, eventId: row.id };
      }),
    };
    const text = 'Je souhaite créer un nouveau client';
    const value = bindAttempt(factory({ append }));

    value.record(transcriptEvent(text));
    await value.drain();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: EVENT_ID,
      eventDigestKeyVersion: 2,
      encryptionKeyVersion: 2,
      canonicalReplyCiphertext: null,
    });
    expect(rows[0]!.transcriptCiphertext).toMatch(
      /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u,
    );
    expect(JSON.stringify(rows[0])).not.toContain(text);
    expect(rows[0]!.event).not.toHaveProperty('transcript');
  });

  it('accepte un replay identique calculé avec l’ancienne version de digest', async () => {
    let original: RealtimeVoiceTraceStoredEvent | null = null;
    const firstStore: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(async (row) => {
        original = row;
        return { status: 'inserted' as const, eventId: row.id };
      }),
    };
    const oldConfig = config({ currentEncryptionVersion: 1 });
    const first = bindAttempt(factory({ append: firstStore, resolved: oldConfig }));
    first.record(transcriptEvent('Entretien vitrines demain'));
    await first.drain();
    expect(original).not.toBeNull();

    const secondLog = logger();
    const secondStore: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(async () => ({
        status: 'existing' as const,
        eventId: original!.id,
        eventDigest: original!.eventDigest,
        eventDigestKeyVersion: original!.eventDigestKeyVersion,
      })),
    };
    const second = bindAttempt(factory({ append: secondStore, log: secondLog }));
    second.record(transcriptEvent('Entretien vitrines demain'));
    await second.drain();

    expect(secondLog.error).not.toHaveBeenCalled();
  });

  it('ouvre le disjoncteur sur replay divergent sans journaliser le contenu', async () => {
    const persisted: RealtimeVoiceTraceStoredEvent[] = [];
    const seed: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(async (row) => {
        persisted.push(row);
        return { status: 'inserted' as const, eventId: row.id };
      }),
    };
    const original = bindAttempt(factory({ append: seed }));
    original.record(transcriptEvent('Contrat 4 saisons'));
    await original.drain();

    const log = logger();
    const replay: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(async (): Promise<RealtimeVoiceTraceAppendOutcome> => ({
        status: 'existing',
        eventId: persisted[0]!.id,
        eventDigest: persisted[0]!.eventDigest,
        eventDigestKeyVersion: persisted[0]!.eventDigestKeyVersion,
      })),
    };
    const divergent = bindAttempt(factory({ append: replay, log }));
    divergent.record(transcriptEvent('Contrat 5 saisons'));
    await divergent.drain();

    expect(log.error).toHaveBeenCalledWith(
      'bob.live.trace.v2.failed class=corrupt_replay',
      undefined,
      'BobLiveTraceV2',
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Contrat');
  });

  it('ferme sa file bornée sans ralentir la voix ni accepter de nouveaux événements', async () => {
    let release = (): void => undefined;
    const append: RealtimeVoiceTraceAppendStore = {
      assertReady: vi.fn(),
      append: vi.fn(
        () =>
          new Promise<RealtimeVoiceTraceAppendOutcome>((resolve) => {
            release = () => resolve({ status: 'inserted', eventId: EVENT_ID });
          }),
      ),
    };
    const log = logger();
    const attempt = bindAttempt(factory({ append, log, queueCapacity: 1 }));

    attempt.record(transcriptEvent('premier'));
    attempt.record(transcriptEvent('deuxième'));
    attempt.record(transcriptEvent('troisième'));
    await vi.waitFor(() => expect(append.append).toHaveBeenCalledTimes(1));
    release();
    await attempt.drain();

    expect(append.append).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'bob.live.trace.v2.failed class=queue_overflow',
      undefined,
      'BobLiveTraceV2',
    );
  });

  it('rejette localement une dérive de session et n’envoie rien au repository', async () => {
    const append = { assertReady: vi.fn(), append: vi.fn() };
    const log = logger();
    const attempt = bindAttempt(factory({ append, log }));

    expect(attempt.bindSession('66666666-6666-4666-8666-666666666666')).toBe(false);
    attempt.record(transcriptEvent('ne doit pas sortir'));
    await attempt.drain();

    expect(append.append).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'bob.live.trace.v2.failed class=identity_drift',
      undefined,
      'BobLiveTraceV2',
    );
  });
});
