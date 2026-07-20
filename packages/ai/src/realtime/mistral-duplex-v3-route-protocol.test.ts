import { describe, expect, it } from 'vitest';
import {
  MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES,
  MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
  MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE,
  MISTRAL_DUPLEX_V3_UPLINK_CHANNELS,
  MISTRAL_DUPLEX_V3_UPLINK_FRAME_BYTES,
  MISTRAL_DUPLEX_V3_UPLINK_FRAME_DURATION_MS,
  MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES,
  MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES,
  MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_FORMAT,
  MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_RATE_HZ,
  MistralDuplexV3RouteProtocolError,
  decodeMistralDuplexV3ReceiverControl,
  decodeMistralDuplexV3ReceiverControlAck,
  decodeMistralDuplexV3RouteAuthenticate,
  decodeMistralDuplexV3UplinkPcmFrame,
  encodeMistralDuplexV3ReceiverControl,
  encodeMistralDuplexV3ReceiverControlAck,
  encodeMistralDuplexV3RouteAuthenticate,
  encodeMistralDuplexV3UplinkPcmFrame,
  isCanonicalMistralDuplexV3ConnectionNonce,
  isCanonicalMistralDuplexV3RouteTicket,
  type MistralDuplexV3ReceiverControl,
  type MistralDuplexV3ReceiverControlAck,
  type MistralDuplexV3ReceiverPlaybackFlushed,
  type MistralDuplexV3RouteAuthenticate,
  type MistralDuplexV3RouteProtocolErrorCode,
} from './mistral-duplex-v3-route-protocol';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const DUPLEX_ID = '10000000-0000-4000-8000-000000000002';
const ROUTE_ID = '10000000-0000-4000-8000-000000000003';
const OTHER_ROUTE_ID = '10000000-0000-4000-8000-000000000004';
const CONTROL_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_CONTROL_ID = '20000000-0000-4000-8000-000000000002';
const TURN_ID = '30000000-0000-4000-8000-000000000001';
const ARTIFACT_ID = '40000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'company-1';
const TICKET = `d3_${'T'.repeat(42)}Q`;
const CONNECTION_NONCE = `n3_${'A'.repeat(43)}`;

function initialAuth(): MistralDuplexV3RouteAuthenticate {
  return {
    type: 'route.authenticate',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    companyId: COMPANY_ID,
    ticket: TICKET,
    duplexId: DUPLEX_ID,
    connectionNonce: CONNECTION_NONCE,
    resume: {
      routeId: null,
      connectionEpoch: 0,
      routeRevision: 0,
      nextDownlinkSequence: 0,
      playbackGeneration: 1,
      lastReceiverRevision: 0,
      lastNativePlaybackRevision: 0,
    },
  };
}

function resumedAuth(): MistralDuplexV3RouteAuthenticate {
  return {
    ...initialAuth(),
    resume: {
      routeId: ROUTE_ID,
      connectionEpoch: 7,
      routeRevision: 12,
      nextDownlinkSequence: 31,
      playbackGeneration: 4,
      lastReceiverRevision: 26,
      lastNativePlaybackRevision: 9,
    },
  };
}

function flowControl(): MistralDuplexV3ReceiverControl {
  return {
    type: 'receiver.control',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    controlId: CONTROL_ID,
    routeId: ROUTE_ID,
    connectionEpoch: 7,
    payload: {
      protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
      type: 'receiver.flow_control',
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 7,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 4,
      receiverRevision: 27,
      nextExpectedSequence: 31,
      consumedThroughChunkIndex: 2,
      pressure: 'accepting',
      routeExhausted: false,
      availableBytes: 16_384,
      availableChunks: 2,
    },
  };
}

function cancelRequestedControl(): MistralDuplexV3ReceiverControl {
  return {
    ...flowControl(),
    payload: {
      protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
      type: 'receiver.cancel_requested',
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 7,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 4,
      receiverRevision: 28,
      reason: 'barge_in',
      nextPlaybackGeneration: 5,
      nativeFlushConfirmed: true,
    },
  };
}

function playbackDrainedControl(): MistralDuplexV3ReceiverControl {
  return {
    ...flowControl(),
    payload: {
      protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
      type: 'receiver.playback_drained',
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 7,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 4,
      receiverRevision: 28,
      closeSequence: 30,
      nextExpectedSequence: 31,
      consumedThroughChunkIndex: 2,
      nativePlaybackRevision: 10,
      drainedAtMonotonicMs: 123_456.5,
      nativeQueueEmpty: true,
    },
  };
}

function playbackFlushed(): MistralDuplexV3ReceiverPlaybackFlushed {
  return {
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    type: 'receiver.playback_flushed',
    sessionId: SESSION_ID,
    duplexId: DUPLEX_ID,
    connectionEpoch: 7,
    turnId: TURN_ID,
    artifactId: ARTIFACT_ID,
    playbackGeneration: 4,
    receiverRevision: 28,
    nativePlaybackRevision: 10,
    nextPlaybackGeneration: 5,
    nativeQueueEmpty: true,
    flushedAtMonotonicMs: 123_456.75,
  };
}

function flushControl(): MistralDuplexV3ReceiverControl {
  return { ...flowControl(), payload: playbackFlushed() };
}

function ack(
  overrides: Partial<MistralDuplexV3ReceiverControlAck> = {},
): MistralDuplexV3ReceiverControlAck {
  return {
    type: 'receiver.control_ack',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    controlId: CONTROL_ID,
    routeId: ROUTE_ID,
    connectionEpoch: 7,
    verdict: 'applied',
    claimState: 'completed',
    routeRevision: 13,
    nextDownlinkSequence: 31,
    playbackGeneration: 5,
    lastReceiverRevision: 28,
    lastNativePlaybackRevision: 10,
    ...overrides,
  };
}

function controlExpectation(overrides: Record<string, unknown> = {}) {
  return {
    routeId: ROUTE_ID,
    duplexId: DUPLEX_ID,
    connectionEpoch: 7,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    artifactId: ARTIFACT_ID,
    playbackGeneration: 4,
    ...overrides,
  };
}

function ackCursor(value: MistralDuplexV3ReceiverControlAck) {
  return {
    verdict: value.verdict,
    claimState: value.claimState,
    routeRevision: value.routeRevision,
    nextDownlinkSequence: value.nextDownlinkSequence,
    playbackGeneration: value.playbackGeneration,
    lastReceiverRevision: value.lastReceiverRevision,
    lastNativePlaybackRevision: value.lastNativePlaybackRevision,
  };
}

function previousAck(value: MistralDuplexV3ReceiverControlAck) {
  return {
    controlId: value.controlId,
    routeId: value.routeId,
    connectionEpoch: value.connectionEpoch,
    ...ackCursor(value),
  };
}

function pcm(seed = 1): Uint8Array {
  const bytes = new Uint8Array(MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (seed + index * 17) & 0xff;
  }
  return bytes;
}

function expectProtocolError(
  action: () => unknown,
  code: MistralDuplexV3RouteProtocolErrorCode,
): MistralDuplexV3RouteProtocolError {
  try {
    action();
    throw new Error('expected_protocol_error');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralDuplexV3RouteProtocolError);
    expect((error as MistralDuplexV3RouteProtocolError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as MistralDuplexV3RouteProtocolError;
  }
}

function withSymbol<T extends object>(value: T): T {
  Object.defineProperty(value, Symbol('forbidden'), {
    enumerable: true,
    value: 'secret',
  });
  return value;
}

function withGetter<T extends object>(value: T, key: keyof T): T {
  const data = value[key];
  Object.defineProperty(value, key, {
    enumerable: true,
    configurable: true,
    get: () => data,
  });
  return value;
}

function withPrototype<T extends object>(value: T): T {
  return Object.assign(Object.create({ inherited: 'forbidden' }) as T, value);
}

describe('Mistral Duplex V3 route protocol — fixed public contract', () => {
  it('pins the exclusive protocol, JSON budget and exact 20 ms uplink format', () => {
    expect(MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL).toBe('bob.mistral-duplex.v3');
    expect(MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES).toBe(4_096);
    expect({
      format: MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_FORMAT,
      rate: MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_RATE_HZ,
      channels: MISTRAL_DUPLEX_V3_UPLINK_CHANNELS,
      duration: MISTRAL_DUPLEX_V3_UPLINK_FRAME_DURATION_MS,
      header: MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES,
      pcm: MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES,
      frame: MISTRAL_DUPLEX_V3_UPLINK_FRAME_BYTES,
    }).toEqual({
      format: 'pcm_s16le',
      rate: 16_000,
      channels: 1,
      duration: 20,
      header: 24,
      pcm: 640,
      frame: 664,
    });
  });
});

describe('Mistral Duplex V3 route protocol — one-shot authentication', () => {
  it('uses canonical, domain-separated 256-bit tickets and connection nonces', () => {
    expect(isCanonicalMistralDuplexV3RouteTicket(TICKET)).toBe(true);
    for (const suffix of 'AEIMQUYcgkosw048') {
      expect(isCanonicalMistralDuplexV3RouteTicket(`d3_${'T'.repeat(42)}${suffix}`)).toBe(true);
      expect(isCanonicalMistralDuplexV3ConnectionNonce(`n3_${'A'.repeat(42)}${suffix}`)).toBe(true);
    }
    expect(isCanonicalMistralDuplexV3ConnectionNonce(CONNECTION_NONCE)).toBe(true);
    expect(isCanonicalMistralDuplexV3RouteTicket(`b3_${'T'.repeat(42)}Q`)).toBe(false);
    expect(isCanonicalMistralDuplexV3RouteTicket(`d3_${'T'.repeat(42)}B`)).toBe(false);
    expect(isCanonicalMistralDuplexV3ConnectionNonce('A'.repeat(43))).toBe(false);
    expect(isCanonicalMistralDuplexV3ConnectionNonce(`n3_${'A'.repeat(42)}B`)).toBe(false);
  });

  it('round-trips brand-new and resumed snapshots without text or PCM', () => {
    for (const auth of [initialAuth(), resumedAuth()]) {
      const encoded = encodeMistralDuplexV3RouteAuthenticate(auth);
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4_096);
      expect(decodeMistralDuplexV3RouteAuthenticate(encoded)).toEqual(auth);
      expect(encoded).not.toContain('transcript');
      expect(encoded).not.toContain('pcm');
      expect(encoded).not.toContain('customer');
    }
  });

  it('requires the complete initial zero tuple and a durable revision for a resumed route', () => {
    const initial = initialAuth();
    for (const resume of [
      { ...initial.resume, connectionEpoch: 1 },
      { ...initial.resume, routeRevision: 1 },
      { ...initial.resume, nextDownlinkSequence: 1 },
      { ...initial.resume, playbackGeneration: 2 },
      { ...initial.resume, lastReceiverRevision: 1 },
      { ...initial.resume, lastNativePlaybackRevision: 1 },
    ]) {
      expectProtocolError(
        () => encodeMistralDuplexV3RouteAuthenticate({ ...initial, resume }),
        'invalid_resume_snapshot',
      );
    }
    for (const resume of [
      { ...resumedAuth().resume, connectionEpoch: 0 },
      { ...resumedAuth().resume, routeRevision: 0 },
    ]) {
      expectProtocolError(
        () => encodeMistralDuplexV3RouteAuthenticate({ ...resumedAuth(), resume }),
        'invalid_resume_snapshot',
      );
    }
  });

  it('rejects duplicate keys, oversize frames, non-canonical numbers and extra data', () => {
    const encoded = encodeMistralDuplexV3RouteAuthenticate(resumedAuth());
    expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(encoded.replace(
        `"ticket":"${TICKET}"`,
        `"ticket":"${TICKET}","ticket":"${TICKET}"`,
      )),
      'invalid_json',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(encoded.replace(
        '"routeRevision":12',
        '"routeRevision":12,"routeRevision":12',
      )),
      'invalid_json',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(`${encoded}${' '.repeat(4_097)}`),
      'text_frame_too_large',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(encoded.replace(
        '"connectionEpoch":7',
        '"connectionEpoch":-0',
      )),
      'invalid_json',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(JSON.stringify({
        ...initialAuth(),
        transcript: 'secret',
      })),
      'invalid_auth',
    );
    expectProtocolError(() => decodeMistralDuplexV3RouteAuthenticate('null'), 'invalid_auth');
  });

  it('rejects prototypes, getters, symbols, NaN and non-canonical nonce input', () => {
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate(withPrototype(initialAuth())),
      'invalid_auth',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate(withGetter(initialAuth(), 'ticket')),
      'invalid_auth',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate(withSymbol(initialAuth())),
      'invalid_auth',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate({
        ...resumedAuth(),
        resume: withGetter({ ...resumedAuth().resume }, 'routeRevision'),
      }),
      'invalid_resume_snapshot',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate({
        ...resumedAuth(),
        resume: withSymbol({ ...resumedAuth().resume }),
      }),
      'invalid_resume_snapshot',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate({
        ...resumedAuth(),
        resume: { ...resumedAuth().resume, routeRevision: Number.NaN },
      }),
      'invalid_resume_snapshot',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate({
        ...initialAuth(),
        connectionNonce: `n3_${'A'.repeat(42)}B`,
      }),
      'invalid_auth',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3RouteAuthenticate({
        ...initialAuth(),
        companyId: '../another-tenant',
      }),
      'invalid_auth',
    );
  });
});

describe('Mistral Duplex V3 route protocol — durable receiver controls', () => {
  it('wraps the existing canonical upstream codec and the native flushed proof', () => {
    for (const control of [
      flowControl(),
      cancelRequestedControl(),
      playbackDrainedControl(),
      flushControl(),
    ]) {
      const encoded = encodeMistralDuplexV3ReceiverControl(control);
      expect(decodeMistralDuplexV3ReceiverControl(encoded, controlExpectation())).toEqual(control);
      expect(encoded).not.toContain('transcript');
      expect(encoded).not.toContain('pcm');
    }
  });

  it('binds outer route epoch and expected duplex identity to the exact payload', () => {
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl({
        ...flowControl(),
        connectionEpoch: 8,
      }),
      'binding_mismatch',
    );
    const encoded = encodeMistralDuplexV3ReceiverControl(flowControl());
    for (const expected of [
      controlExpectation({ routeId: OTHER_ROUTE_ID }),
      controlExpectation({ duplexId: OTHER_ROUTE_ID }),
      controlExpectation({ connectionEpoch: 8 }),
      controlExpectation({ sessionId: OTHER_ROUTE_ID }),
      controlExpectation({ turnId: OTHER_ROUTE_ID }),
      controlExpectation({ artifactId: OTHER_ROUTE_ID }),
      controlExpectation({ playbackGeneration: 5 }),
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexV3ReceiverControl(encoded, expected),
        'binding_mismatch',
      );
    }
  });

  it('requires an exact G+1 native flush with a proven empty queue', () => {
    for (const payload of [
      { ...playbackFlushed(), nextPlaybackGeneration: 4 },
      { ...playbackFlushed(), nextPlaybackGeneration: 6 },
      { ...playbackFlushed(), nativeQueueEmpty: false },
      { ...playbackFlushed(), receiverRevision: 0 },
      { ...playbackFlushed(), nativePlaybackRevision: 0 },
      { ...playbackFlushed(), flushedAtMonotonicMs: -1 },
      { ...playbackFlushed(), flushedAtMonotonicMs: Number.NaN },
      { ...playbackFlushed(), flushedAtMonotonicMs: -0 },
    ]) {
      expectProtocolError(
        () => encodeMistralDuplexV3ReceiverControl({
          ...flowControl(),
          payload: payload as MistralDuplexV3ReceiverPlaybackFlushed,
        }),
        'invalid_control',
      );
    }
  });

  it('rejects duplicate, prototype, getter, symbol, extra text and PCM controls', () => {
    const encoded = encodeMistralDuplexV3ReceiverControl(flowControl());
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControl(encoded.replace(
        `"controlId":"${CONTROL_ID}"`,
        `"controlId":"${CONTROL_ID}","controlId":"${CONTROL_ID}"`,
      )),
      'invalid_json',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl(withPrototype(flowControl())),
      'invalid_control',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl(withGetter(flowControl(), 'payload')),
      'invalid_control',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl(withSymbol(flowControl())),
      'invalid_control',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl({
        ...flowControl(),
        payload: withGetter({ ...flowControl().payload }, 'receiverRevision'),
      } as MistralDuplexV3ReceiverControl),
      'invalid_control',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControl({
        ...flowControl(),
        payload: withSymbol({ ...flowControl().payload }),
      } as MistralDuplexV3ReceiverControl),
      'invalid_control',
    );
    for (const forbidden of [
      { ...flowControl(), transcript: 'client secret' },
      { ...flowControl(), pcm: [1, 2, 3] },
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexV3ReceiverControl(JSON.stringify(forbidden)),
        'invalid_control',
      );
    }
  });
});

describe('Mistral Duplex V3 route protocol — exact idempotent ACK', () => {
  it('round-trips all verdicts and durable claim states allowed by the race', () => {
    const values = [
      ack({ verdict: 'applied', claimState: 'opened' }),
      ack({ verdict: 'replayed', claimState: 'completed' }),
      ack({ verdict: 'superseded', claimState: 'revoked' }),
      ack({ verdict: 'superseded', claimState: 'expired' }),
      ack({ lastReceiverRevision: 9, lastNativePlaybackRevision: 10 }),
    ];
    for (const value of values) {
      const encoded = encodeMistralDuplexV3ReceiverControlAck(value);
      expect(decodeMistralDuplexV3ReceiverControlAck(encoded, {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: previousAck(value),
        accepted: [ackCursor(value)],
      })).toEqual(value);
      expect(encoded).not.toContain('transcript');
      expect(encoded).not.toContain('pcm');
    }
  });

  it('binds verdict and claim state to every accepted ACK and equal-revision replay', () => {
    const applied = ack({ verdict: 'applied', claimState: 'completed' });
    const forgedSemanticOutcome = ack({
      verdict: 'superseded',
      claimState: 'revoked',
    });
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(
        encodeMistralDuplexV3ReceiverControlAck(forgedSemanticOutcome),
        {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: null,
          accepted: [ackCursor(applied)],
        },
      ),
      'cursor_regression',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(
        encodeMistralDuplexV3ReceiverControlAck(applied),
        {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: previousAck(ack({
            verdict: 'replayed',
            claimState: 'completed',
          })),
          accepted: [ackCursor(applied)],
        },
      ),
      'cursor_regression',
    );
    const advancedSameControl = ack({
      routeRevision: 14,
      nextDownlinkSequence: 32,
      verdict: 'replayed',
      claimState: 'completed',
    });
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(
        encodeMistralDuplexV3ReceiverControlAck(advancedSameControl),
        {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: previousAck(applied),
          accepted: [ackCursor(advancedSameControl)],
        },
      ),
      'cursor_regression',
    );

    const priorControl = ack({
      controlId: OTHER_CONTROL_ID,
      verdict: 'applied',
      claimState: 'completed',
    });
    expect(decodeMistralDuplexV3ReceiverControlAck(
      encodeMistralDuplexV3ReceiverControlAck(forgedSemanticOutcome),
      {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: previousAck(priorControl),
        accepted: [ackCursor(forgedSemanticOutcome)],
      },
    )).toEqual(forgedSemanticOutcome);
  });

  it('requires an exact expectation at the public decoder boundary', () => {
    const encoded = encodeMistralDuplexV3ReceiverControlAck(ack());
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(encoded, undefined as never),
      'binding_mismatch',
    );
  });

  it('snapshots the accepted-choice array without invoking a Proxy length getter', () => {
    const value = ack();
    let lengthReads = 0;
    const accepted = new Proxy([ackCursor(value)], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return 4;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(decodeMistralDuplexV3ReceiverControlAck(
      encodeMistralDuplexV3ReceiverControlAck(value),
      {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: null,
        accepted,
      },
    )).toEqual(value);
    expect(lengthReads).toBe(0);
  });

  it('accepts an equal replay revision, rejects regression and cross-route ACKs', () => {
    const encoded = encodeMistralDuplexV3ReceiverControlAck(ack({ routeRevision: 13 }));
    expect(decodeMistralDuplexV3ReceiverControlAck(encoded, {
      controlId: CONTROL_ID,
      routeId: ROUTE_ID,
      connectionEpoch: 7,
      previous: previousAck(ack({ routeRevision: 13 })),
      accepted: [ackCursor(ack({ routeRevision: 13 }))],
    }).routeRevision).toBe(13);
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(encoded, {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: previousAck(ack({ routeRevision: 14 })),
        accepted: [ackCursor(ack({ routeRevision: 13 }))],
      }),
      'cursor_regression',
    );
    for (const previous of [
      ack({ routeRevision: 12, nextDownlinkSequence: 32 }),
      ack({ routeRevision: 12, playbackGeneration: 6 }),
      ack({ routeRevision: 12, lastReceiverRevision: 29 }),
      ack({ routeRevision: 12, lastNativePlaybackRevision: 11 }),
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexV3ReceiverControlAck(encoded, {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: previousAck(previous),
          accepted: [ackCursor(ack({ routeRevision: 13 }))],
        }),
        'cursor_regression',
      );
    }
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(
        encodeMistralDuplexV3ReceiverControlAck(ack({
          routeRevision: 13,
          nextDownlinkSequence: 32,
        })),
        {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: previousAck(ack({ routeRevision: 13 })),
          accepted: [ackCursor(ack({ routeRevision: 13 }))],
        },
      ),
      'cursor_regression',
    );
    const impossibleFuture = ack({
      routeRevision: 14,
      nextDownlinkSequence: 2_147_483_647,
      playbackGeneration: 2_147_483_645,
      lastReceiverRevision: 2_147_483_647,
      lastNativePlaybackRevision: 2_147_483_647,
    });
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(
        encodeMistralDuplexV3ReceiverControlAck(impossibleFuture),
        {
          controlId: CONTROL_ID,
          routeId: ROUTE_ID,
          connectionEpoch: 7,
          previous: previousAck(ack({ routeRevision: 13 })),
          accepted: [ackCursor(ack({ routeRevision: 14 }))],
        },
      ),
      'cursor_regression',
    );
    for (const expected of [
      { controlId: OTHER_ROUTE_ID, routeId: ROUTE_ID, connectionEpoch: 7 },
      { controlId: CONTROL_ID, routeId: OTHER_ROUTE_ID, connectionEpoch: 7 },
      { controlId: CONTROL_ID, routeId: ROUTE_ID, connectionEpoch: 8 },
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexV3ReceiverControlAck(encoded, {
          ...expected,
          previous: null,
          accepted: [ackCursor(ack({ routeRevision: 13 }))],
        }),
        'binding_mismatch',
      );
    }
  });

  it('rejects impossible/ambiguous states, duplicate cursors and hostile objects', () => {
    for (const value of [
      ack({ verdict: 'superseded', claimState: 'opened' }),
      ack({ routeRevision: 0 }),
      ack({ routeRevision: Number.NaN }),
      ack({ connectionEpoch: -0 }),
      ack({ playbackGeneration: 0 }),
      ack({ lastReceiverRevision: -1 }),
    ]) {
      expectProtocolError(
        () => encodeMistralDuplexV3ReceiverControlAck(value),
        'invalid_control_ack',
      );
    }
    const encoded = encodeMistralDuplexV3ReceiverControlAck(ack());
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(encoded, {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: null,
        accepted: [ackCursor(ack()), ackCursor(ack())],
      }),
      'binding_mismatch',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3ReceiverControlAck(encoded.replace(
        '"routeRevision":13',
        '"routeRevision":13,"routeRevision":13',
      ), {
        controlId: CONTROL_ID,
        routeId: ROUTE_ID,
        connectionEpoch: 7,
        previous: null,
        accepted: [ackCursor(ack())],
      }),
      'invalid_json',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControlAck(withPrototype(ack())),
      'invalid_control_ack',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControlAck(withGetter(ack(), 'routeRevision')),
      'invalid_control_ack',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3ReceiverControlAck(withSymbol(ack())),
      'invalid_control_ack',
    );
  });
});

describe('Mistral Duplex V3 route protocol — fixed binary microphone uplink', () => {
  it('round-trips one exact 640-byte PCM quantum with fixed canonical header', () => {
    const source = pcm(9);
    const encoded = encodeMistralDuplexV3UplinkPcmFrame({
      connectionEpoch: 7,
      captureSequence: 23,
      pcm: source,
    });
    expect(encoded).toHaveLength(664);
    expect(Array.from(encoded.slice(0, 24))).toEqual([
      0x42, 0x4f, 0x42, 0x55,
      3, 1, 1, 1,
      20, 0, 0, 0,
      0, 0, 0x3e, 0x80,
      0, 0, 0, 7,
      0, 0, 0, 23,
    ]);
    const decoded = decodeMistralDuplexV3UplinkPcmFrame(encoded, {
      connectionEpoch: 7,
      captureSequence: 23,
    });
    expect(decoded).toEqual({ connectionEpoch: 7, captureSequence: 23, pcm: source });
    expect(decoded.pcm).not.toBe(source);
    expect(decoded.pcm).not.toBe(encoded.subarray(24));
    source.fill(0);
    expect(decoded.pcm.some((value) => value !== 0)).toBe(true);
  });

  it('rejects short, trailing, variable PCM and every reserved/fixed-header mutation', () => {
    const encoded = encodeMistralDuplexV3UplinkPcmFrame({
      connectionEpoch: 7,
      captureSequence: 23,
      pcm: pcm(),
    });
    for (const malformed of [
      encoded.slice(0, -1),
      Uint8Array.from([...encoded, 0]),
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexV3UplinkPcmFrame(malformed, {
          connectionEpoch: 7,
          captureSequence: 23,
        }),
        'invalid_pcm_frame',
      );
    }
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      const malformed = encoded.slice();
      malformed[offset] = malformed[offset]! ^ 0x01;
      expectProtocolError(
        () => decodeMistralDuplexV3UplinkPcmFrame(malformed, {
          connectionEpoch: 7,
          captureSequence: 23,
        }),
        'invalid_pcm_frame',
      );
    }
    const zeroEpoch = encoded.slice();
    zeroEpoch.fill(0, 16, 20);
    expectProtocolError(
      () => decodeMistralDuplexV3UplinkPcmFrame(zeroEpoch, {
        connectionEpoch: 7,
        captureSequence: 23,
      }),
      'invalid_pcm_frame',
    );
    for (const bytes of [new Uint8Array(639), new Uint8Array(641)]) {
      expectProtocolError(
        () => encodeMistralDuplexV3UplinkPcmFrame({
          connectionEpoch: 7,
          captureSequence: 23,
          pcm: bytes,
        }),
        'invalid_pcm_frame',
      );
    }
  });

  it('requires exact monotone sequence and epoch expectations, including uint32 bounds', () => {
    const zero = encodeMistralDuplexV3UplinkPcmFrame({
      connectionEpoch: 7,
      captureSequence: 0,
      pcm: pcm(),
    });
    expect(decodeMistralDuplexV3UplinkPcmFrame(zero, {
      connectionEpoch: 7,
      captureSequence: 0,
    }).captureSequence).toBe(0);
    expectProtocolError(
      () => decodeMistralDuplexV3UplinkPcmFrame(zero, {
        connectionEpoch: 8,
        captureSequence: 0,
      }),
      'binding_mismatch',
    );
    expectProtocolError(
      () => decodeMistralDuplexV3UplinkPcmFrame(zero, {
        connectionEpoch: 7,
        captureSequence: 1,
      }),
      'capture_sequence_mismatch',
    );
    const maximum = encodeMistralDuplexV3UplinkPcmFrame({
      connectionEpoch: 7,
      captureSequence: MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE,
      pcm: pcm(),
    });
    expect(decodeMistralDuplexV3UplinkPcmFrame(maximum, {
      connectionEpoch: 7,
      captureSequence: MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE,
    }).captureSequence).toBe(MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE);
    for (const captureSequence of [
      -1,
      -0,
      Number.NaN,
      MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE + 1,
      0x1_0000_0000,
    ]) {
      expectProtocolError(
        () => encodeMistralDuplexV3UplinkPcmFrame({
          connectionEpoch: 7,
          captureSequence,
          pcm: pcm(),
        }),
        'invalid_pcm_frame',
      );
    }
    for (const connectionEpoch of [0, -0, Number.NaN, 0x8000_0000]) {
      expectProtocolError(
        () => encodeMistralDuplexV3UplinkPcmFrame({
          connectionEpoch,
          captureSequence: 1,
          pcm: pcm(),
        }),
        'invalid_pcm_frame',
      );
    }
  });

  it('rejects prototype/getter/symbol envelopes and non-canonical typed arrays', () => {
    const valid = { connectionEpoch: 7, captureSequence: 1, pcm: pcm() };
    expectProtocolError(
      () => encodeMistralDuplexV3UplinkPcmFrame(withPrototype(valid)),
      'invalid_pcm_frame',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3UplinkPcmFrame(withGetter(valid, 'pcm')),
      'invalid_pcm_frame',
    );
    expectProtocolError(
      () => encodeMistralDuplexV3UplinkPcmFrame(withSymbol(valid)),
      'invalid_pcm_frame',
    );
    const decoratedPcm = pcm();
    Object.defineProperty(decoratedPcm, 'forbidden', { enumerable: true, value: 1 });
    expectProtocolError(
      () => encodeMistralDuplexV3UplinkPcmFrame({
        connectionEpoch: 7,
        captureSequence: 1,
        pcm: decoratedPcm,
      }),
      'invalid_pcm_frame',
    );
    const proxiedPcm = new Proxy(pcm(), {});
    expectProtocolError(
      () => encodeMistralDuplexV3UplinkPcmFrame({
        connectionEpoch: 7,
        captureSequence: 1,
        pcm: proxiedPcm,
      }),
      'invalid_pcm_frame',
    );
  });
});

describe('Mistral Duplex V3 route protocol — privacy-safe diagnostics', () => {
  it('never copies tickets, identities or business text into an error', () => {
    const secret = 'Marie Durand — chantier rue Exemple';
    const error = expectProtocolError(
      () => decodeMistralDuplexV3RouteAuthenticate(JSON.stringify({
        ...initialAuth(),
        ticket: secret,
      })),
      'invalid_auth',
    );
    expect(error.message).not.toContain('Marie');
    expect(error.message).not.toContain('chantier');
    expect(error.message).not.toContain(TICKET);
  });
});
