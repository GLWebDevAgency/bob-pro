import { describe, expect, it } from 'vitest';

import {
  assertBobLiveAudioCapabilities,
  BOB_LIVE_AUDIO_FRAME_BYTES,
  BOB_LIVE_VAD_PROFILE,
  BobLiveAudioContractError,
  BobLiveAudioPcmStreamDecoder,
  BobLiveAudioVadStreamDecoder,
  decodeBobLiveAudioPcmChunk,
} from './BobLiveAudio.contract';

const SESSION_ID = 'session-123';
const CAPTURE_ID = 'capture-456';
const FRAME = new Uint8Array(BOB_LIVE_AUDIO_FRAME_BYTES).map((_, index) => index % 251);

function frameBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

describe('Bob Live native audio contract', () => {
  it('decode uniquement une trame PCM16 canonique de 40 ms pour la session attendue', () => {
    expect(
      decodeBobLiveAudioPcmChunk(
        {
          sessionId: SESSION_ID,
          captureId: CAPTURE_ID,
          sequence: 0,
          capturedAtMonotonicMs: 42,
          pcmBase64: frameBase64(FRAME),
        },
        SESSION_ID,
        CAPTURE_ID,
      ),
    ).toEqual(FRAME);
  });

  it.each([
    null,
    'not-an-event',
    [],
    {},
    { sessionId: 'another-session' },
    { captureId: 'another-capture' },
    { sequence: -1 },
    { sequence: Number.NaN },
    { capturedAtMonotonicMs: -1 },
    { pcmBase64: 'AAAA' },
    { unexpected: true },
    { pcmBase64: `%${frameBase64(FRAME).slice(1)}` },
    { pcmBase64: `${frameBase64(FRAME).slice(0, -2)}B=` },
  ])('refuse une trame native hors contrat: %o', (override) => {
    const event =
      typeof override === 'object' &&
      override !== null &&
      !Array.isArray(override) &&
      Object.keys(override).length > 0
        ? {
            sessionId: SESSION_ID,
            captureId: CAPTURE_ID,
            sequence: 0,
            capturedAtMonotonicMs: 42,
            pcmBase64: frameBase64(FRAME),
            ...override,
          }
        : override;
    expect(() => decodeBobLiveAudioPcmChunk(event, SESSION_ID, CAPTURE_ID)).toThrow(
      BobLiveAudioContractError,
    );
  });

  it('ne laisse jamais fuiter une exception de getter depuis la frontiere native', () => {
    const hostile = Object.defineProperty({}, 'sessionId', {
      get() {
        throw new TypeError('native getter failed');
      },
    });
    expect(() => decodeBobLiveAudioPcmChunk(hostile, SESSION_ID, CAPTURE_ID)).toThrow(
      BobLiveAudioContractError,
    );
  });

  it('fence une capture par session, sequence sans trou et horloge monotone', () => {
    const decoder = new BobLiveAudioPcmStreamDecoder(SESSION_ID, CAPTURE_ID);
    const event = (sequence: number, capturedAtMonotonicMs: number) => ({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      sequence,
      capturedAtMonotonicMs,
      pcmBase64: frameBase64(FRAME),
    });

    expect(decoder.decode(event(0, 100))).toEqual({
      sequence: 0,
      capturedAtMonotonicMs: 100,
      pcm: FRAME,
    });
    expect(() => decoder.decode(event(0, 101))).toThrow(BobLiveAudioContractError);
    expect(() => decoder.decode(event(2, 102))).toThrow(BobLiveAudioContractError);
    expect(decoder.decode(event(1, 100))).toEqual({
      sequence: 1,
      capturedAtMonotonicMs: 100,
      pcm: FRAME,
    });
    expect(() => decoder.decode(event(2, 99))).toThrow(BobLiveAudioContractError);
    expect(() => new BobLiveAudioPcmStreamDecoder('../invalid', CAPTURE_ID)).toThrow(
      BobLiveAudioContractError,
    );
    expect(() => new BobLiveAudioPcmStreamDecoder(SESSION_ID, '../invalid')).toThrow(
      BobLiveAudioContractError,
    );
  });

  it('refuse toute dérive de format ou annonce full-duplex non certifiée', () => {
    const valid = {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      encoding: 'pcm_s16le',
      sampleRateHz: 16_000,
      channels: 1,
      frameDurationMs: 40,
      maxInFlightFrames: 16,
      maxCaptureDurationMs: 900_000,
      acousticEchoCancellation: 'enabled',
      noiseSuppression: 'enabled',
      automaticGainControl: 'unknown',
      vadConfigVersion: 'bob-live-vad-foundation-1',
      vadEventOrdering: 'pcm_before_vad',
      vadAnalysisWindowMs: 20,
      vadPreRollMs: 240,
      vadSpeechStartMs: 60,
      vadSpeechEndMs: 700,
      vadMaximumUtteranceMs: 30_000,
      fullDuplexCertified: false,
    } as const;
    expect(() => assertBobLiveAudioCapabilities(valid, SESSION_ID)).not.toThrow();
    expect(() =>
      assertBobLiveAudioCapabilities(
        {
          ...valid,
          fullDuplexCertified: true as false,
        },
        SESSION_ID,
      ),
    ).toThrow(BobLiveAudioContractError);
    expect(() =>
      assertBobLiveAudioCapabilities(
        {
          ...valid,
          noiseSuppression: 'invented' as 'enabled',
        },
        SESSION_ID,
      ),
    ).toThrow(BobLiveAudioContractError);
    expect(() => assertBobLiveAudioCapabilities(null, SESSION_ID)).toThrow(
      BobLiveAudioContractError,
    );
    expect(() =>
      assertBobLiveAudioCapabilities(
        {
          ...valid,
          maxCaptureDurationMs: 900_001,
        },
        SESSION_ID,
      ),
    ).toThrow(BobLiveAudioContractError);
    expect(() =>
      assertBobLiveAudioCapabilities(
        {
          ...valid,
          maxCaptureDurationMs: 999,
        },
        SESSION_ID,
      ),
    ).toThrow(BobLiveAudioContractError);
    for (const incompatibleVadProfile of [
      { vadConfigVersion: 'bob-live-vad-foundation-2' },
      { vadEventOrdering: 'vad_before_pcm' },
      { vadAnalysisWindowMs: 40 },
      { vadPreRollMs: 200 },
      { vadSpeechStartMs: 40 },
      { vadSpeechEndMs: 680 },
      { vadMaximumUtteranceMs: 29_000 },
    ]) {
      expect(() =>
        assertBobLiveAudioCapabilities(
          {
            ...valid,
            ...incompatibleVadProfile,
          },
          SESSION_ID,
        ),
      ).toThrow(BobLiveAudioContractError);
    }
    expect(() =>
      assertBobLiveAudioCapabilities(
        {
          ...valid,
          unexpectedNativeCapability: true,
        },
        SESSION_ID,
      ),
    ).toThrow(BobLiveAudioContractError);
    const missingVadVersion: Record<string, unknown> = { ...valid };
    delete missingVadVersion.vadConfigVersion;
    expect(() => assertBobLiveAudioCapabilities(missingVadVersion, SESSION_ID)).toThrow(
      BobLiveAudioContractError,
    );

    const hostile = Object.defineProperty({}, 'sessionId', {
      get() {
        throw new TypeError('native getter failed');
      },
    });
    expect(() => assertBobLiveAudioCapabilities(hostile, SESSION_ID)).toThrow(
      BobLiveAudioContractError,
    );
  });

  it('corrèle strictement start/end VAD dans une capture et conserve le profil', () => {
    const decoder = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    const start = {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      kind: 'speech_started',
      configVersion: 'bob-live-vad-foundation-1',
      utteranceIndex: 1,
      detectedAtMonotonicMs: 1_060,
      preRollMs: 240,
      startedAtMonotonicMs: 1_000,
      endedAtMonotonicMs: null,
      forcedEnd: false,
      energyDbfs: -24.5,
      noiseFloorDbfs: -60,
    } as const;
    const end = {
      ...start,
      kind: 'speech_ended',
      detectedAtMonotonicMs: 2_700,
      endedAtMonotonicMs: 2_000,
    } as const;

    expect(decoder.decode(start)).toEqual(start);
    expect(decoder.decode(end)).toEqual(end);
    const second = {
      ...start,
      utteranceIndex: 2,
      detectedAtMonotonicMs: 3_060,
      startedAtMonotonicMs: 3_000,
    } as const;
    expect(decoder.decode(second)).toEqual(second);
  });

  it('verrouille les invariants temporels complets du profil VAD négocié', () => {
    expect(BOB_LIVE_VAD_PROFILE).toEqual({
      configVersion: 'bob-live-vad-foundation-1',
      analysisWindowMs: 20,
      preRollMs: 240,
      speechStartMs: 60,
      speechEndMs: 700,
      maximumUtteranceMs: 30_000,
    });
    expect(
      () => new BobLiveAudioVadStreamDecoder(SESSION_ID, CAPTURE_ID, 'bob-live-vad-foundation-2'),
    ).toThrow(BobLiveAudioContractError);

    const startedAtMonotonicMs = 1_000.123_456;
    const start = {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      kind: 'speech_started',
      configVersion: 'bob-live-vad-foundation-1',
      utteranceIndex: 1,
      detectedAtMonotonicMs: startedAtMonotonicMs + 60,
      preRollMs: 220,
      startedAtMonotonicMs,
      endedAtMonotonicMs: null,
      forcedEnd: false,
      energyDbfs: -24,
      noiseFloorDbfs: -60,
    } as const;
    const naturalEnd = {
      ...start,
      kind: 'speech_ended',
      detectedAtMonotonicMs: startedAtMonotonicMs + 800,
      endedAtMonotonicMs: startedAtMonotonicMs + 100,
    } as const;
    const natural = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    expect(natural.decode(start)).toEqual(start);
    expect(natural.decode(naturalEnd)).toEqual(naturalEnd);

    const forcedEnd = {
      ...start,
      kind: 'speech_ended',
      detectedAtMonotonicMs: startedAtMonotonicMs + 30_000,
      endedAtMonotonicMs: startedAtMonotonicMs + 30_000,
      forcedEnd: true,
    } as const;
    const forced = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    forced.decode(start);
    expect(forced.decode(forcedEnd)).toEqual(forcedEnd);
  });

  it.each([
    { detectedAtMonotonicMs: 1_059 },
    { detectedAtMonotonicMs: 1_061 },
    { detectedAtMonotonicMs: 1_060.002 },
    { preRollMs: 241 },
    { preRollMs: 230 },
    { preRollMs: -0 },
  ])('refuse un début impossible pour le profil VAD: %o', (override) => {
    const decoder = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    expect(() =>
      decoder.decode({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        kind: 'speech_started',
        configVersion: 'bob-live-vad-foundation-1',
        utteranceIndex: 1,
        detectedAtMonotonicMs: 1_060,
        preRollMs: 240,
        startedAtMonotonicMs: 1_000,
        endedAtMonotonicMs: null,
        forcedEnd: false,
        energyDbfs: -24,
        noiseFloorDbfs: -60,
        ...override,
      }),
    ).toThrow(BobLiveAudioContractError);
  });

  it.each([
    { detectedAtMonotonicMs: 1_799, endedAtMonotonicMs: 1_100 },
    { detectedAtMonotonicMs: 1_801, endedAtMonotonicMs: 1_100 },
    { detectedAtMonotonicMs: 1_800.002, endedAtMonotonicMs: 1_100 },
    { detectedAtMonotonicMs: 1_801, endedAtMonotonicMs: 1_101 },
    { detectedAtMonotonicMs: 1_750, endedAtMonotonicMs: 1_050 },
    { detectedAtMonotonicMs: 31_000, endedAtMonotonicMs: 30_300 },
    {
      detectedAtMonotonicMs: 31_020,
      endedAtMonotonicMs: 31_000,
      forcedEnd: true,
    },
    {
      detectedAtMonotonicMs: 30_980,
      endedAtMonotonicMs: 30_980,
      forcedEnd: true,
    },
  ])('refuse une fin impossible pour le profil VAD: %o', (override) => {
    const decoder = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    const start = {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      kind: 'speech_started',
      configVersion: 'bob-live-vad-foundation-1',
      utteranceIndex: 1,
      detectedAtMonotonicMs: 1_060,
      preRollMs: 240,
      startedAtMonotonicMs: 1_000,
      endedAtMonotonicMs: null,
      forcedEnd: false,
      energyDbfs: -24,
      noiseFloorDbfs: -60,
    } as const;
    decoder.decode(start);
    expect(() =>
      decoder.decode({
        ...start,
        kind: 'speech_ended',
        ...override,
      }),
    ).toThrow(BobLiveAudioContractError);
  });

  it.each([
    { kind: 'speech_ended', endedAtMonotonicMs: 1_010 },
    { utteranceIndex: 0 },
    { configVersion: '../unsafe' },
    { configVersion: 'bob-live-vad-foundation-2' },
    { detectedAtMonotonicMs: 999 },
    { preRollMs: 301 },
    { endedAtMonotonicMs: 1_001 },
    { forcedEnd: true },
    { energyDbfs: 1 },
    { noiseFloorDbfs: Number.NaN },
    { unexpected: true },
  ])('refuse une transition VAD native invalide: %o', (override) => {
    const decoder = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    const start = {
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      kind: 'speech_started',
      configVersion: 'bob-live-vad-foundation-1',
      utteranceIndex: 1,
      detectedAtMonotonicMs: 1_060,
      preRollMs: 240,
      startedAtMonotonicMs: 1_000,
      endedAtMonotonicMs: null,
      forcedEnd: false,
      energyDbfs: -24,
      noiseFloorDbfs: -60,
      ...override,
    };
    expect(() => decoder.decode(start)).toThrow(BobLiveAudioContractError);
  });

  it('refuse chevauchement, fin orpheline, profil divergent et retour d’horloge VAD', () => {
    const event = (overrides: Record<string, unknown> = {}) => ({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      kind: 'speech_started',
      configVersion: 'bob-live-vad-foundation-1',
      utteranceIndex: 1,
      detectedAtMonotonicMs: 1_060,
      preRollMs: 240,
      startedAtMonotonicMs: 1_000,
      endedAtMonotonicMs: null,
      forcedEnd: false,
      energyDbfs: -24,
      noiseFloorDbfs: -60,
      ...overrides,
    });

    expect(
      () => new BobLiveAudioVadStreamDecoder('../bad', CAPTURE_ID, 'bob-live-vad-foundation-1'),
    ).toThrow(BobLiveAudioContractError);
    expect(
      () => new BobLiveAudioVadStreamDecoder(SESSION_ID, '../bad', 'bob-live-vad-foundation-1'),
    ).toThrow(BobLiveAudioContractError);
    expect(() => new BobLiveAudioVadStreamDecoder(SESSION_ID, CAPTURE_ID, '../bad')).toThrow(
      BobLiveAudioContractError,
    );
    expect(() =>
      new BobLiveAudioVadStreamDecoder(SESSION_ID, CAPTURE_ID, 'bob-live-vad-foundation-1').decode(
        event({
          kind: 'speech_ended',
          endedAtMonotonicMs: 1_020,
        }),
      ),
    ).toThrow(BobLiveAudioContractError);

    const decoder = new BobLiveAudioVadStreamDecoder(
      SESSION_ID,
      CAPTURE_ID,
      'bob-live-vad-foundation-1',
    );
    decoder.decode(event());
    expect(() => decoder.decode(event({ utteranceIndex: 2 }))).toThrow(BobLiveAudioContractError);
    expect(() =>
      decoder.decode(
        event({
          kind: 'speech_ended',
          configVersion: 'bob-live-vad-foundation-2',
          endedAtMonotonicMs: 1_020,
        }),
      ),
    ).toThrow(BobLiveAudioContractError);
    expect(() =>
      decoder.decode(
        event({
          kind: 'speech_ended',
          detectedAtMonotonicMs: 1_050,
          endedAtMonotonicMs: 1_020,
        }),
      ),
    ).toThrow(BobLiveAudioContractError);
  });
});
