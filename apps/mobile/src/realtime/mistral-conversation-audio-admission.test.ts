import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES,
  decodeMistralConversationAudioFrame,
} from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';

import {
  MistralConversationAudioAdmission,
  MistralConversationAudioAdmissionError,
  type MistralConversationAudioAdmissionErrorCode,
} from './mistral-conversation-audio-admission';

const PCM = Uint8Array.from(
  { length: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES },
  (_, index) => index % 251,
);

function admission(
  overrides: Partial<ConstructorParameters<typeof MistralConversationAudioAdmission>[0]> = {},
): MistralConversationAudioAdmission {
  return new MistralConversationAudioAdmission({
    turnOrdinal: 7,
    nextAudioSequence: 42,
    remainingTurnAudioBytes: MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES,
    remainingMissionAudioBytes: MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
    ...overrides,
  });
}

function expectAdmissionError(
  run: () => unknown,
  code: MistralConversationAudioAdmissionErrorCode,
): void {
  try {
    run();
    throw new Error('expected admission error');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralConversationAudioAdmissionError);
    expect((error as MistralConversationAudioAdmissionError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

function containsPcm(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((nested) => containsPcm(nested, seen));
}

describe('Mistral conversation v2 audio admission', () => {
  it('attribue le curseur serveur sans jamais caster captureSequence en audioSequence', () => {
    const subject = admission();
    const outbound: Uint8Array[] = [];

    const first = subject.tryAdmit({ captureSequence: 900, pcm: PCM }, (encoded) => {
      outbound.push(Uint8Array.from(encoded));
      return true;
    });
    const second = subject.tryAdmit({ captureSequence: 901, pcm: PCM }, (encoded) => {
      outbound.push(Uint8Array.from(encoded));
      return true;
    });

    expect(first).toEqual({
      kind: 'admitted',
      captureSequence: 900,
      audioSequence: 42,
      audioBytes: PCM.byteLength,
    });
    expect(second).toMatchObject({ captureSequence: 901, audioSequence: 43 });
    expect(outbound.map((encoded) => decodeMistralConversationAudioFrame(encoded))).toEqual([
      { turnOrdinal: 7, audioSequence: 42, pcm: PCM },
      { turnOrdinal: 7, audioSequence: 43, pcm: PCM },
    ]);
    expect(subject.commit()).toBe(43);
    expect(subject.snapshot.lastAdmittedAudioSequence).toBe(43);
  });

  it('ne brûle ni séquence ni budget quand trySend refuse puis admet la même trame', () => {
    const subject = admission({
      remainingTurnAudioBytes: PCM.byteLength * 2,
      remainingMissionAudioBytes: PCM.byteLength * 2,
    });
    const rejected = subject.tryAdmit({ captureSequence: 12, pcm: PCM }, () => false);

    expect(rejected).toEqual({
      kind: 'backpressured',
      captureSequence: 12,
      audioSequence: 42,
    });
    expect(subject.snapshot).toMatchObject({
      nextAudioSequence: 42,
      lastAdmittedAudioSequence: null,
      admittedAudioBytes: 0,
      remainingTurnAudioBytes: PCM.byteLength * 2,
      remainingMissionAudioBytes: PCM.byteLength * 2,
    });
    expectAdmissionError(() => subject.commit(), 'invalid_state');

    expect(subject.tryAdmit({ captureSequence: 12, pcm: PCM }, () => true)).toMatchObject({
      kind: 'admitted',
      audioSequence: 42,
    });
    expect(subject.snapshot).toMatchObject({
      nextAudioSequence: 43,
      admittedAudioBytes: PCM.byteLength,
      remainingTurnAudioBytes: PCM.byteLength,
      remainingMissionAudioBytes: PCM.byteLength,
    });
    expect(subject.tryAdmit({ captureSequence: 13, pcm: PCM }, () => false)).toMatchObject({
      kind: 'backpressured',
      audioSequence: 43,
    });
    expect(subject.commit()).toBe(42);
    expect(subject.commit()).toBe(42);
  });

  it('reste inchangé après exception ou résultat non booléen du transport', () => {
    const subject = admission();
    expectAdmissionError(
      () =>
        subject.tryAdmit({ captureSequence: 1, pcm: PCM }, () => {
          throw new Error('socket internals must stay private');
        }),
      'send_failed',
    );
    expectAdmissionError(
      () =>
        subject.tryAdmit({ captureSequence: 1, pcm: PCM }, (() =>
          Promise.resolve(true)) as unknown as () => boolean),
      'send_failed',
    );
    expect(subject.snapshot).toMatchObject({
      nextAudioSequence: 42,
      lastAdmittedAudioSequence: null,
      admittedAudioBytes: 0,
    });
    expect(subject.tryAdmit({ captureSequence: 1, pcm: PCM }, () => true)).toMatchObject({
      audioSequence: 42,
    });
  });

  it('fail-close les bornes uint32, ordinal, budgets, tailles et quanta', () => {
    for (const invalid of [0, -0, -1, 1.5, 0x1_0000_0000, Number.NaN]) {
      expectAdmissionError(() => admission({ turnOrdinal: invalid }), 'invalid_configuration');
    }
    for (const invalid of [-0, -1, 1.5, 0x1_0000_0000, Number.NaN]) {
      expectAdmissionError(
        () => admission({ nextAudioSequence: invalid }),
        'invalid_configuration',
      );
    }
    for (const invalid of [-0, -1, 1, MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES + 320]) {
      expectAdmissionError(
        () => admission({ remainingTurnAudioBytes: invalid }),
        'invalid_configuration',
      );
    }
    expectAdmissionError(
      () =>
        admission({
          remainingMissionAudioBytes: MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES + 320,
        }),
      'invalid_configuration',
    );

    const trySend = vi.fn(() => true);
    for (const captureSequence of [-0, -1, 1.5, 0x1_0000_0000, Number.NaN]) {
      expectAdmissionError(
        () => admission().tryAdmit({ captureSequence, pcm: PCM }, trySend),
        'invalid_frame',
      );
    }
    for (const pcm of [
      new Uint8Array(0),
      new Uint8Array(MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES + 1),
      new Uint8Array(MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES + 320),
    ]) {
      expectAdmissionError(
        () => admission().tryAdmit({ captureSequence: 1, pcm }, trySend),
        'invalid_frame',
      );
    }
    expect(trySend).not.toHaveBeenCalled();
  });

  it('refuse avant envoi quand le budget est insuffisant et ne le consomme pas', () => {
    const subject = admission({
      remainingTurnAudioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
      remainingMissionAudioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
    });
    const trySend = vi.fn(() => true);
    const twoQuanta = new Uint8Array(MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES * 2);

    expectAdmissionError(
      () => subject.tryAdmit({ captureSequence: 8, pcm: twoQuanta }, trySend),
      'audio_budget_exceeded',
    );
    expect(trySend).not.toHaveBeenCalled();
    expect(subject.snapshot).toMatchObject({
      nextAudioSequence: 42,
      admittedAudioBytes: 0,
      remainingTurnAudioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
      remainingMissionAudioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
    });
  });

  it('admet UINT32_MAX une seule fois et committe exactement cette valeur', () => {
    const subject = admission({ nextAudioSequence: 0xffff_ffff });
    expect(subject.tryAdmit({ captureSequence: 4, pcm: PCM }, () => true)).toMatchObject({
      audioSequence: 0xffff_ffff,
    });
    expect(subject.snapshot.nextAudioSequence).toBeNull();
    expectAdmissionError(
      () => subject.tryAdmit({ captureSequence: 5, pcm: PCM }, () => true),
      'sequence_exhausted',
    );
    expect(subject.commit()).toBe(0xffff_ffff);
  });

  it('annulation et recovery scellent la capture sans callback ni replay PCM', () => {
    const cancelled = admission();
    const cancelledSend = vi.fn(() => true);
    cancelled.tryAdmit({ captureSequence: 1, pcm: PCM }, cancelledSend);
    cancelled.cancel();
    cancelled.cancel();
    expect(cancelledSend).toHaveBeenCalledTimes(1);
    expectAdmissionError(
      () => cancelled.tryAdmit({ captureSequence: 2, pcm: PCM }, cancelledSend),
      'invalid_state',
    );
    expectAdmissionError(() => cancelled.commit(), 'invalid_state');

    const cancelledAfterCommit = admission();
    cancelledAfterCommit.tryAdmit({ captureSequence: 2, pcm: PCM }, () => true);
    expect(cancelledAfterCommit.commit()).toBe(42);
    cancelledAfterCommit.cancel();
    expect(cancelledAfterCommit.snapshot.phase).toBe('cancelled');

    const recovering = admission();
    const recoverySend = vi.fn(() => true);
    recovering.tryAdmit({ captureSequence: 10, pcm: PCM }, recoverySend);
    recovering.beginRecovery();
    recovering.beginRecovery();
    expect(recoverySend).toHaveBeenCalledTimes(1);
    expectAdmissionError(
      () => recovering.tryAdmit({ captureSequence: 10, pcm: PCM }, recoverySend),
      'invalid_state',
    );
    expect(recovering.snapshot).toMatchObject({
      phase: 'recovering',
      lastAdmittedAudioSequence: 42,
    });
  });

  it('ne conserve aucun buffer PCM et interdit une admission réentrante', () => {
    const subject = admission();
    let nestedCode: string | null = null;
    const input = Uint8Array.from(PCM);
    const result = subject.tryAdmit({ captureSequence: 33, pcm: input }, () => {
      try {
        subject.tryAdmit({ captureSequence: 34, pcm: PCM }, () => true);
      } catch (error) {
        nestedCode = (error as MistralConversationAudioAdmissionError).code;
      }
      input.fill(0);
      return true;
    });

    expect(nestedCode).toBe('invalid_state');
    expect(result).toMatchObject({ audioSequence: 42, audioBytes: PCM.byteLength });
    expect(containsPcm(subject)).toBe(false);
    expect(containsPcm(subject.snapshot)).toBe(false);
  });
});
