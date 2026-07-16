import { describe, expect, it } from 'vitest';

import type { BobLiveAudioVadEvent } from '../../modules/bob-live-audio/src/BobLiveAudio.types';
import {
  BobLiveNativeVadCaptureError,
  BobLiveNativeVadCaptureStream,
  BobLiveNativeVadPcmRing,
  type BobLiveNativeCaptureFrame,
} from './bob-live-native-vad-capture';

const FRAME_BYTES = 1_280;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function frame(sequence: number, startedAtMonotonicMs = sequence * 40): BobLiveNativeCaptureFrame {
  return {
    captureSequence: sequence,
    startedAtMonotonicMs,
    pcm: new Uint8Array(FRAME_BYTES).fill(sequence + 1),
  };
}

function vad(
  kind: BobLiveAudioVadEvent['kind'],
  overrides: Partial<BobLiveAudioVadEvent> = {},
): BobLiveAudioVadEvent {
  return {
    sessionId: 'session-1',
    captureId: 'capture-1',
    kind,
    configVersion: 'bob-live-vad-foundation-1',
    utteranceIndex: 1,
    detectedAtMonotonicMs: kind === 'speech_started' ? 300 : 1_700,
    preRollMs: 240,
    startedAtMonotonicMs: 240,
    endedAtMonotonicMs: kind === 'speech_started' ? null : 1_000,
    forcedEnd: false,
    energyDbfs: kind === 'speech_started' ? -24 : -120,
    noiseFloorDbfs: -60,
    ...overrides,
  };
}

describe('Bob Live native VAD PCM ring', () => {
  it('reconstruit le pré-roll exact puis remet les trames actives jusqu’à endpoint', () => {
    const ring = new BobLiveNativeVadPcmRing();
    for (let sequence = 0; sequence < 8; sequence += 1) {
      expect(ring.acceptPcm(frame(sequence))).toEqual({ kind: 'buffered' });
    }

    const started = ring.acceptVad(vad('speech_started'));
    expect(started.kind).toBe('speech_started');
    if (started.kind !== 'speech_started') throw new Error('unexpected');
    expect(started.initialFrames).toHaveLength(8);
    expect(started.initialFrames[0]).toEqual(frame(0));
    expect(started.initialFrames.at(-1)).toEqual(frame(7));

    const active = ring.acceptPcm(frame(8));
    expect(active).toEqual({ kind: 'speech_frame', frame: frame(8) });
    const ended = ring.acceptVad(vad('speech_ended'));
    expect(ended).toEqual(expect.objectContaining({
      kind: 'speech_ended',
      lastForwardedCaptureSequence: 8,
    }));
    expect(ring.acceptPcm(frame(9))).toEqual({ kind: 'buffered' });
  });

  it('découpe la première trame uniquement sur un quantum PCM de 10 ms', () => {
    const ring = new BobLiveNativeVadPcmRing();
    for (let sequence = 0; sequence < 8; sequence += 1) ring.acceptPcm(frame(sequence));

    const started = ring.acceptVad(vad('speech_started', {
      startedAtMonotonicMs: 260,
      detectedAtMonotonicMs: 320,
    }));
    if (started.kind !== 'speech_started') throw new Error('unexpected');
    expect(started.initialFrames[0]).toEqual({
      captureSequence: 0,
      startedAtMonotonicMs: 20,
      pcm: frame(0).pcm.subarray(640),
    });
    expect(started.initialFrames[0]?.pcm).toHaveLength(640);
  });

  it('échoue fermé si le ring ne couvre pas le pré-roll annoncé', () => {
    const ring = new BobLiveNativeVadPcmRing();
    ring.acceptPcm(frame(0, 200));
    ring.acceptPcm(frame(1, 240));
    expect(() => ring.acceptVad(vad('speech_started'))).toThrowError(
      expect.objectContaining({ code: 'insufficient_pre_roll' }),
    );
  });

  it('refuse séquence, taille, chevauchement et quantum VAD ambigus', () => {
    const ring = new BobLiveNativeVadPcmRing();
    expect(() => ring.acceptPcm({ ...frame(0), pcm: new Uint8Array(640) })).toThrow(
      BobLiveNativeVadCaptureError,
    );
    ring.acceptPcm(frame(0));
    expect(() => ring.acceptPcm(frame(0, 40))).toThrow(BobLiveNativeVadCaptureError);
    expect(() => ring.acceptPcm(frame(1, 39))).toThrow(BobLiveNativeVadCaptureError);

    const quantumRing = new BobLiveNativeVadPcmRing();
    for (let sequence = 0; sequence < 8; sequence += 1) quantumRing.acceptPcm(frame(sequence));
    expect(() => quantumRing.acceptVad(vad('speech_started', {
      startedAtMonotonicMs: 255,
      detectedAtMonotonicMs: 315,
    }))).toThrowError(expect.objectContaining({ code: 'invalid_vad_transition' }));
  });

  it('refuse fin orpheline et chevauchement de deux énoncés', () => {
    const ring = new BobLiveNativeVadPcmRing();
    for (let sequence = 0; sequence < 8; sequence += 1) ring.acceptPcm(frame(sequence));
    expect(() => ring.acceptVad(vad('speech_ended'))).toThrowError(
      expect.objectContaining({ code: 'invalid_vad_transition' }),
    );
    ring.acceptVad(vad('speech_started'));
    expect(() => ring.acceptVad(vad('speech_started', { utteranceIndex: 2 }))).toThrowError(
      expect.objectContaining({ code: 'invalid_vad_transition' }),
    );
  });

  it('copie le PCM natif et reset invalide toute continuité précédente', () => {
    const ring = new BobLiveNativeVadPcmRing();
    const mutable = frame(0);
    ring.acceptPcm(mutable);
    mutable.pcm.fill(99);
    ring.reset();
    expect(() => ring.acceptPcm(frame(1))).toThrow(BobLiveNativeVadCaptureError);
    expect(ring.acceptPcm(frame(0, 1_000))).toEqual({ kind: 'buffered' });
  });

  it('valide la génération native complète avant de remettre PCM/VAD au ring', () => {
    const stream = new BobLiveNativeVadCaptureStream(
      'session-1',
      'capture-1',
      'bob-live-vad-foundation-1',
    );
    for (let sequence = 0; sequence < 8; sequence += 1) {
      expect(stream.acceptPcmEvent({
        sessionId: 'session-1',
        captureId: 'capture-1',
        sequence,
        capturedAtMonotonicMs: sequence * 40,
        pcmBase64: base64(frame(sequence).pcm),
      })).toEqual({ kind: 'buffered' });
    }
    expect(stream.acceptVadEvent(vad('speech_started'))).toEqual(expect.objectContaining({
      kind: 'speech_started',
      initialFrames: expect.any(Array),
    }));
    expect(() => stream.acceptVadEvent({
      ...vad('speech_ended'),
      captureId: 'stale-capture',
    })).toThrow();
  });

  it('lie le premier événement VAD au profil négocié par prepareAsync', () => {
    const stream = new BobLiveNativeVadCaptureStream(
      'session-1',
      'capture-1',
      'bob-live-vad-foundation-1',
    );
    for (let sequence = 0; sequence < 8; sequence += 1) {
      stream.acceptPcmEvent({
        sessionId: 'session-1',
        captureId: 'capture-1',
        sequence,
        capturedAtMonotonicMs: sequence * 40,
        pcmBase64: base64(frame(sequence).pcm),
      });
    }
    expect(() => stream.acceptVadEvent(vad('speech_started', {
      configVersion: 'bob-live-vad-foundation-2',
    }))).toThrow();
  });
});
