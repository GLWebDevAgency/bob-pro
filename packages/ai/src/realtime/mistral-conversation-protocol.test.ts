import { describe, expect, it } from 'vitest';
import {
  INITIAL_MISTRAL_CONVERSATION_MISSION_STATE,
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
  MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES,
  MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES,
  MISTRAL_CONVERSATION_PROTOCOL,
  MistralConversationProtocolError,
  createMistralConversationTurnState,
  decodeMistralConversationAudioFrame,
  decodeMistralConversationClientControl,
  decodeMistralConversationServerEvent,
  encodeMistralConversationAudioFrame,
  encodeMistralConversationClientControl,
  encodeMistralConversationServerEvent,
  reduceMistralConversationMissionState,
  reduceMistralConversationTurnState,
  type MistralConversationClientControl,
  type MistralConversationMissionState,
  type MistralConversationServerEvent,
  type MistralConversationTurnState,
} from './mistral-conversation-protocol';

const CLIENT_TURN_1 = '10000000-0000-4000-8000-000000000001';
const CLIENT_TURN_2 = '10000000-0000-4000-8000-000000000002';
const CANCELLATION_1 = '20000000-0000-4000-8000-000000000001';
const CANCELLATION_2 = '20000000-0000-4000-8000-000000000002';
const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);
const SESSION_HANDLE = 'session_handle_1234567890abcdef';
const TURN_1 = 'turn_1234567890abcdef';
const TURN_2 = 'turn_abcdef1234567890';
const EXPIRES_AT = '2026-07-15T12:30:00.000Z';
const MISSION_AUDIO_BUDGET = 32_000;
const TURN_1_VAD = { vadStartedAtMs: 1_000, preRollMs: 200 } as const;
const TURN_2_VAD = { vadStartedAtMs: 2_000, preRollMs: 200 } as const;

function expectProtocolError(
  action: () => unknown,
  code: MistralConversationProtocolError['code'],
): void {
  try {
    action();
    throw new Error('expected protocol error');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralConversationProtocolError);
    expect((error as MistralConversationProtocolError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

function startControl(
  clientTurnId = CLIENT_TURN_1,
  contextRevision = 1,
  contextDigest = DIGEST_1,
): Extract<MistralConversationClientControl, { readonly type: 'turn.start' }> {
  return {
    type: 'turn.start',
    clientTurnId,
    contextRevision,
    contextDigest,
    vadStartedAtMs: 1_000,
    preRollMs: 200,
  };
}

function readyMission(
  nextAudioSequence = 0,
  maxMissionAudioBytes = MISSION_AUDIO_BUDGET,
): MistralConversationMissionState {
  return reduceMistralConversationMissionState(INITIAL_MISTRAL_CONVERSATION_MISSION_STATE, {
    type: 'SESSION_READY',
    sessionHandle: SESSION_HANDLE,
    missionConnectionEpoch: 1,
    expiresAt: EXPIRES_AT,
    contextRevision: 1,
    contextDigest: DIGEST_1,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    nextAudioSequence,
    maxMissionAudioBytes,
  });
}

function activeMission(): MistralConversationMissionState {
  return reduceMistralConversationMissionState(readyMission(), {
    type: 'TURN_STARTED',
    clientTurnId: CLIENT_TURN_1,
    turnId: TURN_1,
    ordinal: 1,
    contextRevision: 1,
    contextDigest: DIGEST_1,
    firstAudioSequence: 0,
    ...TURN_1_VAD,
  });
}

function responseMission(): MistralConversationMissionState {
  let state = activeMission();
  for (const audioSequence of [0, 1, 2]) {
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence,
      audioBytes: 320,
    });
  }
  return reduceMistralConversationMissionState(state, {
    type: 'TURN_COMMITTED',
    clientTurnId: CLIENT_TURN_1,
    turnId: TURN_1,
    ordinal: 1,
    lastAudioSequence: 2,
    vadEndedAtMs: 1_400,
  });
}

function acceptedTurn(firstAudioSequence = 0): MistralConversationTurnState {
  return reduceMistralConversationTurnState(createMistralConversationTurnState(startControl()), {
    type: 'ACCEPT',
    turnId: TURN_1,
    ordinal: 1,
    cancellationGeneration: 0,
    firstAudioSequence,
  });
}

describe('Bob Mistral conversation v2 — contrôles client stricts', () => {
  const controls: readonly MistralConversationClientControl[] = [
    {
      type: 'authenticate',
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      companyId: 'company-42',
      ticket: 'A'.repeat(32),
      resumeNextServerSequence: 0,
    },
    startControl(),
    {
      type: 'turn.commit',
      clientTurnId: CLIENT_TURN_1,
      lastAudioSequence: 42,
      vadEndedAtMs: 1_750,
    },
    {
      type: 'turn.cancel',
      clientTurnId: CLIENT_TURN_1,
      cancellationId: CANCELLATION_1,
      reason: 'barge_in',
    },
    { type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 },
    { type: 'events.ack', missionConnectionEpoch: 2, nextServerSequence: 42 },
    { type: 'session.end', reason: 'background' },
  ];

  it.each(controls.map((control) => [control.type, control] as const))(
    'aller-retour exact %s',
    (_type, control) => {
      expect(decodeMistralConversationClientControl(
        encodeMistralConversationClientControl(control),
      )).toEqual(control);
    },
  );

  it('refuse JSON invalide, payload non texte et message surdimensionné sans fuite', () => {
    expectProtocolError(() => decodeMistralConversationClientControl('{'), 'invalid_json');
    expectProtocolError(() => decodeMistralConversationClientControl(new Uint8Array()), 'invalid_json');
    expectProtocolError(
      () => decodeMistralConversationClientControl(' '.repeat(MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES + 1)),
      'message_too_large',
    );
  });

  it('refuse champs inconnus, coercitions et version différente', () => {
    expectProtocolError(
      () => decodeMistralConversationClientControl(JSON.stringify({ ...startControl(), extra: true })),
      'invalid_message',
    );
    expectProtocolError(
      () => decodeMistralConversationClientControl(JSON.stringify({ ...startControl(), contextRevision: '1' })),
      'invalid_message',
    );
    expectProtocolError(
      () => decodeMistralConversationClientControl(JSON.stringify({
        type: 'authenticate',
        protocol: 'bob.mistral-pcm.v1',
        companyId: 'company-42',
        ticket: 'A'.repeat(32),
        resumeNextServerSequence: 0,
      })),
      'invalid_message',
    );
  });

  it('borne strictement le curseur de reprise et les ACK cumulatifs', () => {
    const authenticate = controls[0];
    if (!authenticate || authenticate.type !== 'authenticate') throw new Error('invalid_test_fixture');
    for (const resumeNextServerSequence of [-1, 0.5, 0x1_0000_0001]) {
      expectProtocolError(
        () => decodeMistralConversationClientControl(JSON.stringify({
          ...authenticate,
          resumeNextServerSequence,
        })),
        'invalid_message',
      );
    }
    expect(decodeMistralConversationClientControl(JSON.stringify({
      ...authenticate,
      resumeNextServerSequence: 0x1_0000_0000,
    }))).toMatchObject({ resumeNextServerSequence: 0x1_0000_0000 });
    expectProtocolError(
      () => decodeMistralConversationClientControl(
        `{"type":"authenticate","protocol":"${MISTRAL_CONVERSATION_PROTOCOL}","companyId":"company-42","ticket":"${'A'.repeat(32)}","resumeNextServerSequence":-0}`,
      ),
      'invalid_message',
    );

    for (const invalid of [
      { type: 'events.ack', missionConnectionEpoch: 0, nextServerSequence: 1 },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: -1 },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 1, extra: true },
      { type: 'session.end', reason: 'service_shutdown' },
      { type: 'session.end' },
    ]) {
      expectProtocolError(
        () => decodeMistralConversationClientControl(JSON.stringify(invalid)),
        'invalid_message',
      );
    }
  });

  it.each([
    { clientTurnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() },
    { contextRevision: 0 },
    { contextDigest: 'A'.repeat(64) },
    { vadStartedAtMs: -1 },
    { preRollMs: MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS + 1 },
    { preRollMs: 0.5 },
  ])('refuse un turn.start hors contrat: %o', (override) => {
    expectProtocolError(
      () => decodeMistralConversationClientControl(JSON.stringify({ ...startControl(), ...override })),
      'invalid_message',
    );
  });

  it('refuse séquence, horloge, cancellation et raison invalides', () => {
    expectProtocolError(() => decodeMistralConversationClientControl(
      `{"type":"turn.commit","clientTurnId":"${CLIENT_TURN_1}","lastAudioSequence":-0,"vadEndedAtMs":1500}`,
    ), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationClientControl(JSON.stringify({
      type: 'turn.cancel',
      clientTurnId: CLIENT_TURN_1,
      cancellationId: 'not-a-uuid',
      reason: 'maybe',
    })), 'invalid_message');
  });

  it('revalide les objets JavaScript au moment de les encoder', () => {
    const polluted = { ...startControl(), debug: 'secret' } as unknown as MistralConversationClientControl;
    expectProtocolError(() => encodeMistralConversationClientControl(polluted), 'invalid_message');
  });
});

describe('Bob Mistral conversation v2 — enveloppe PCM BOB2', () => {
  it('encode et décode un subarray sans perdre offset, ordre réseau ni PCM', () => {
    const pcm = Uint8Array.from({ length: 640 }, (_, index) => index % 251);
    const encoded = encodeMistralConversationAudioFrame({
      turnOrdinal: 7,
      audioSequence: 42,
      pcm,
    });
    expect([...encoded.subarray(0, 4)]).toEqual([0x42, 0x4f, 0x42, 0x32]);
    const wrapped = new Uint8Array(encoded.byteLength + 8);
    wrapped.set(encoded, 4);
    const decoded = decodeMistralConversationAudioFrame(wrapped.subarray(4, 4 + encoded.byteLength));
    expect(decoded.turnOrdinal).toBe(7);
    expect(decoded.audioSequence).toBe(42);
    expect(decoded.pcm).toEqual(pcm);
  });

  it('copie défensivement le PCM décodé', () => {
    const encoded = encodeMistralConversationAudioFrame({
      turnOrdinal: 1,
      audioSequence: 0,
      pcm: new Uint8Array(320).fill(9),
    });
    const decoded = decodeMistralConversationAudioFrame(encoded);
    encoded[20] = 3;
    expect(decoded.pcm[0]).toBe(9);
  });

  it('accepte les bornes 10 ms et 100 ms, y compris un ArrayBuffer', () => {
    const minimum = encodeMistralConversationAudioFrame({
      turnOrdinal: 1,
      audioSequence: 0,
      pcm: new Uint8Array(MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES),
    });
    expect(decodeMistralConversationAudioFrame(minimum.buffer).pcm).toHaveLength(320);
    expect(decodeMistralConversationAudioFrame(encodeMistralConversationAudioFrame({
      turnOrdinal: 0xffff_ffff,
      audioSequence: 0xffff_ffff,
      pcm: new Uint8Array(MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES),
    })).pcm).toHaveLength(3_200);
  });

  it.each([0, 319, 321, 3_520])('refuse une taille PCM non certifiée: %i', (length) => {
    expectProtocolError(() => encodeMistralConversationAudioFrame({
      turnOrdinal: 1,
      audioSequence: 0,
      pcm: new Uint8Array(length),
    }), 'invalid_frame');
  });

  it('refuse ordinal nul, séquence hors uint32 et type binaire inconnu', () => {
    expectProtocolError(() => encodeMistralConversationAudioFrame({
      turnOrdinal: 0,
      audioSequence: 0,
      pcm: new Uint8Array(320),
    }), 'invalid_frame');
    expectProtocolError(() => encodeMistralConversationAudioFrame({
      turnOrdinal: 1,
      audioSequence: 0x1_0000_0000,
      pcm: new Uint8Array(320),
    }), 'invalid_frame');
    expectProtocolError(() => decodeMistralConversationAudioFrame('binary'), 'invalid_frame');
  });

  it.each([
    ['magic', 0, 0],
    ['version', 4, 1],
    ['encoding', 5, 2],
    ['header bytes', 7, 19],
    ['ordinal', 11, 0],
    ['payload length', 19, 0],
  ] as const)('refuse un header %s altéré', (_name, offset, replacement) => {
    const encoded = encodeMistralConversationAudioFrame({
      turnOrdinal: 1,
      audioSequence: 0,
      pcm: new Uint8Array(320),
    });
    encoded[offset] = replacement;
    expectProtocolError(() => decodeMistralConversationAudioFrame(encoded), 'invalid_frame');
  });
});

describe('Bob Mistral conversation v2 — événements serveur stricts', () => {
  const turnCorrelation = {
    clientTurnId: CLIENT_TURN_1,
    turnId: TURN_1,
    ordinal: 1,
  } as const;
  const events: readonly MistralConversationServerEvent[] = [
    {
      type: 'session.ready',
      serverSequence: 0,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      expiresAt: EXPIRES_AT,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      routeMode: 'push_to_talk',
      fullDuplexCertified: false,
      nextAudioSequence: 0,
      maxMissionAudioBytes: MISSION_AUDIO_BUDGET,
    },
    {
      type: 'turn.started',
      serverSequence: 1,
      ...turnCorrelation,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      cancellationGeneration: 0,
      firstAudioSequence: 0,
      ...TURN_1_VAD,
    },
    {
      type: 'turn.committed',
      serverSequence: 2,
      ...turnCorrelation,
      lastAudioSequence: 2,
      vadEndedAtMs: 1_400,
    },
    { type: 'turn.phase', serverSequence: 3, ...turnCorrelation, phase: 'transcribing' },
    { type: 'turn.transcript', serverSequence: 4, ...turnCorrelation, text: 'Bonjour 👋', final: true },
    {
      type: 'turn.cancelled',
      serverSequence: 5,
      ...turnCorrelation,
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    },
    { type: 'turn.completed', serverSequence: 6, ...turnCorrelation },
    { type: 'session.route_recovering', serverSequence: 7, cancellationGeneration: 1 },
    {
      type: 'session.route_recovered',
      serverSequence: 8,
      missionConnectionEpoch: 2,
      routeMode: 'full_duplex',
      fullDuplexCertified: true,
    },
    {
      type: 'session.context_updated',
      serverSequence: 9,
      contextRevision: 2,
      contextDigest: DIGEST_2,
    },
    {
      type: 'session.draining',
      serverSequence: 10,
      reason: 'service_shutdown',
      cancellationGeneration: 1,
    },
    { type: 'session.closed', serverSequence: 11, reason: 'service_shutdown' },
    { type: 'error', serverSequence: 12, code: 'temporarily_unavailable', retryable: true },
  ];

  it.each(events.map((event) => [event.type, event] as const))(
    'aller-retour exact %s',
    (_type, event) => {
      expect(decodeMistralConversationServerEvent(
        encodeMistralConversationServerEvent(event),
      )).toEqual(event);
    },
  );

  it('refuse tout champ inconnu et revalide aussi à l’encodage', () => {
    const event = events[0];
    expect(event).toBeDefined();
    expectProtocolError(
      () => decodeMistralConversationServerEvent(JSON.stringify({ ...event, providerSessionId: 'leak' })),
      'invalid_message',
    );
    expectProtocolError(
      () => encodeMistralConversationServerEvent({ ...event, debug: true } as unknown as MistralConversationServerEvent),
      'invalid_message',
    );
  });

  it('refuse une élévation duplex non certifiée et les dates non canoniques', () => {
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      ...(events[0] as MistralConversationServerEvent),
      routeMode: 'full_duplex',
      fullDuplexCertified: false,
    })), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      ...(events[0] as MistralConversationServerEvent),
      expiresAt: '2026-07-15T12:30:00Z',
    })), 'invalid_message');
    expect(decodeMistralConversationServerEvent(JSON.stringify({
      ...(events[0] as MistralConversationServerEvent),
      routeMode: 'push_to_talk',
      fullDuplexCertified: true,
    }))).toMatchObject({ routeMode: 'push_to_talk', fullDuplexCertified: true });
  });

  it('refuse identités non canoniques, phases/codes ouverts et séquence -0', () => {
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      type: 'turn.completed',
      serverSequence: 1,
      ...turnCorrelation,
      clientTurnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
    })), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationServerEvent(
      '{"type":"error","serverSequence":-0,"code":"temporarily_unavailable","retryable":true}',
    ), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      type: 'turn.phase', serverSequence: 1, ...turnCorrelation, phase: 'executing_control',
    })), 'invalid_message');
  });

  it('borne les transcripts en UTF-8 valide', () => {
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      type: 'turn.transcript',
      serverSequence: 1,
      ...turnCorrelation,
      text: '\ud800',
      final: false,
    })), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      type: 'turn.transcript',
      serverSequence: 1,
      ...turnCorrelation,
      text: 'x'.repeat(4_001),
      final: false,
    })), 'invalid_message');
    expectProtocolError(() => decodeMistralConversationServerEvent(JSON.stringify({
      type: 'turn.transcript',
      serverSequence: 1,
      ...turnCorrelation,
      text: 'avant\u0000après',
      final: false,
    })), 'invalid_message');
  });
});

describe('Bob Mistral conversation v2 — machine de mission', () => {
  it('enchaîne plusieurs tours sur une mission et avance contexte, ordinal et séquence', () => {
    let state = responseMission();
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    });
    expect(state.phase).toBe('ready');
    expect(state.nextAudioSequence).toBe(3);

    state = reduceMistralConversationMissionState(state, {
      type: 'CONTEXT_UPDATED',
      contextRevision: 2,
      contextDigest: DIGEST_2,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 2,
      contextDigest: DIGEST_2,
      firstAudioSequence: 3,
      ...TURN_2_VAD,
    });
    expect(state).toMatchObject({
      phase: 'turn_active',
      lastTurnOrdinal: 2,
      contextRevision: 2,
      contextDigest: DIGEST_2,
    });
  });

  it('rend les ACK start/commit/completed exactement idempotents', () => {
    const started = activeMission();
    expect(reduceMistralConversationMissionState(started, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0,
      ...TURN_1_VAD,
    })).toBe(started);
    const committed = responseMission();
    expect(reduceMistralConversationMissionState(committed, {
      type: 'TURN_COMMITTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      lastAudioSequence: 2,
      vadEndedAtMs: 1_400,
    })).toBe(committed);
    const completed = reduceMistralConversationMissionState(committed, {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    });
    expect(reduceMistralConversationMissionState(completed, {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    })).toBe(completed);
  });

  it('rejette trou ordinal, collision de digest et séquence globale non continue', () => {
    const ready = readyMission();
    expectProtocolError(() => reduceMistralConversationMissionState(ready, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 2,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0,
      ...TURN_1_VAD,
    }), 'invalid_state_transition');
    expectProtocolError(() => reduceMistralConversationMissionState(ready, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      contextRevision: 1,
      contextDigest: DIGEST_2,
      firstAudioSequence: 0,
      ...TURN_1_VAD,
    }), 'invalid_state_transition');
    expectProtocolError(() => reduceMistralConversationMissionState(ready, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 4,
      ...TURN_1_VAD,
    }), 'invalid_state_transition');
  });

  it('acquitte un nouveau contexte uniquement au repos et rend son replay exact idempotent', () => {
    const ready = readyMission();
    const updated = reduceMistralConversationMissionState(ready, {
      type: 'CONTEXT_UPDATED',
      contextRevision: 2,
      contextDigest: DIGEST_2,
    });
    expect(updated).toMatchObject({ contextRevision: 2, contextDigest: DIGEST_2, phase: 'ready' });
    expect(reduceMistralConversationMissionState(updated, {
      type: 'CONTEXT_UPDATED',
      contextRevision: 2,
      contextDigest: DIGEST_2,
    })).toBe(updated);
    expectProtocolError(() => reduceMistralConversationMissionState(activeMission(), {
      type: 'CONTEXT_UPDATED',
      contextRevision: 2,
      contextDigest: DIGEST_2,
    }), 'invalid_state_transition');
    expectProtocolError(() => reduceMistralConversationMissionState(updated, {
      type: 'CONTEXT_UPDATED',
      contextRevision: 2,
      contextDigest: DIGEST_1,
    }), 'invalid_state_transition');
    const afterFirstTurn = reduceMistralConversationMissionState(responseMission(), {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    });
    expectProtocolError(() => reduceMistralConversationMissionState(afterFirstTurn, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 2,
      contextDigest: DIGEST_2,
      firstAudioSequence: 3,
      ...TURN_2_VAD,
    }), 'invalid_state_transition');
  });

  it('applique le budget mission côté autorité et ne consomme rien lors du rejet', () => {
    let state = reduceMistralConversationMissionState(readyMission(0, 320), {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0,
      ...TURN_1_VAD,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 0,
      audioBytes: 320,
    });
    expect(state).toMatchObject({ audioBytes: 320, nextAudioSequence: 1 });
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 0,
      audioBytes: 320,
    }), 'sequence_error');
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 1,
      audioBytes: 320,
    }), 'audio_budget_exceeded');
    expect(state).toMatchObject({ audioBytes: 320, nextAudioSequence: 1 });
    expectProtocolError(() => readyMission(0, 321), 'invalid_state_transition');
  });

  it('impose une horloge VAD monotone entre les tours', () => {
    const state = reduceMistralConversationMissionState(responseMission(), {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    });
    expect(state.lastVadTimestampMs).toBe(1_400);
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 3,
      vadStartedAtMs: 1_399,
      preRollMs: 200,
    }), 'invalid_state_transition');
  });

  it('brûle chaque séquence admise même si le tour est annulé avant commit', () => {
    let state = activeMission();
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 0,
      audioBytes: 320,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 1,
      audioBytes: 320,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_CANCELLED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    });
    expect(state.nextAudioSequence).toBe(2);
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0,
      ...TURN_2_VAD,
    }), 'invalid_state_transition');
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 2,
      ...TURN_2_VAD,
    });
    expect(state.activeTurn?.firstAudioSequence).toBe(2);
  });

  it('exige que commit corresponde exactement à la dernière frame admise', () => {
    let state = activeMission();
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 0,
      audioBytes: 320,
    });
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_COMMITTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      lastAudioSequence: 1,
      vadEndedAtMs: 1_400,
    }), 'sequence_error');
  });

  it('effectue un barge-in atomique : réponse annulée avant activation du nouveau tour', () => {
    const interrupted = responseMission();
    const state = reduceMistralConversationMissionState(interrupted, {
      type: 'BARGE_IN',
      cancelledTurnId: TURN_1,
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
      nextTurn: {
        clientTurnId: CLIENT_TURN_2,
        turnId: TURN_2,
        ordinal: 2,
        contextRevision: 1,
        contextDigest: DIGEST_1,
        firstAudioSequence: 3,
        ...TURN_2_VAD,
      },
    });
    expect(state).toMatchObject({
      phase: 'turn_active',
      cancellationGeneration: 1,
      lastCancellationId: CANCELLATION_1,
      activeTurn: { turnId: TURN_2, cancellationGeneration: 1 },
      lastTerminalTurn: {
        turnId: TURN_1,
        outcome: 'cancelled',
        cancellationId: CANCELLATION_1,
      },
    });
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    }), 'invalid_state_transition');
  });

  it('impose une génération d’annulation strictement monotone et replayable', () => {
    const active = activeMission();
    const cancelled = reduceMistralConversationMissionState(active, {
      type: 'TURN_CANCELLED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    });
    const replay = {
      type: 'TURN_CANCELLED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    } as const;
    expect(reduceMistralConversationMissionState(cancelled, replay)).toBe(cancelled);
    expectProtocolError(() => reduceMistralConversationMissionState(active, {
      ...replay,
      cancellationGeneration: 2,
    }), 'cancellation_conflict');
  });

  it('annule obligatoirement le tour actif avant récupération de route', () => {
    const active = activeMission();
    expectProtocolError(() => reduceMistralConversationMissionState(active, {
      type: 'ROUTE_RECOVERY_STARTED',
      cancellation: null,
    }), 'cancellation_conflict');
    let state = reduceMistralConversationMissionState(active, {
      type: 'ROUTE_RECOVERY_STARTED',
      cancellation: { cancellationId: CANCELLATION_1, cancellationGeneration: 1 },
    });
    expect(state).toMatchObject({ phase: 'recovering_route', activeTurn: null, cancellationGeneration: 1 });
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'ROUTE_RECOVERY_STARTED',
      cancellation: null,
    }), 'invalid_state_transition');
    state = reduceMistralConversationMissionState(state, {
      type: 'ROUTE_RECOVERED',
      missionConnectionEpoch: 2,
      routeMode: 'full_duplex',
      fullDuplexCertified: true,
    });
    expect(state).toMatchObject({ phase: 'ready', missionConnectionEpoch: 2, routeMode: 'full_duplex' });
  });

  it('draine avec annulation, ferme sans raccourci et interdit toute résurrection', () => {
    const active = activeMission();
    let state = reduceMistralConversationMissionState(active, {
      type: 'DRAIN',
      reason: 'background',
      cancellation: { cancellationId: CANCELLATION_1, cancellationGeneration: 1 },
    });
    expect(state).toMatchObject({ phase: 'draining', activeTurn: null, drainReason: 'background' });
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'DRAIN',
      reason: 'background',
      cancellation: null,
    }), 'invalid_state_transition');
    state = reduceMistralConversationMissionState(state, { type: 'CLOSE' });
    expect(state.phase).toBe('closed');
    expect(reduceMistralConversationMissionState(state, { type: 'CLOSE' })).toBe(state);
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'ROUTE_RECOVERED',
      missionConnectionEpoch: 2,
      routeMode: 'push_to_talk',
      fullDuplexCertified: false,
    }), 'invalid_state_transition');
  });

  it('interdit le wrap silencieux de la séquence audio globale', () => {
    let state = readyMission(0xffff_ffff);
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0xffff_ffff,
      ...TURN_1_VAD,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_AUDIO_INGESTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      audioSequence: 0xffff_ffff,
      audioBytes: 320,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_COMMITTED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
      lastAudioSequence: 0xffff_ffff,
      vadEndedAtMs: 1_400,
    });
    state = reduceMistralConversationMissionState(state, {
      type: 'TURN_COMPLETED',
      clientTurnId: CLIENT_TURN_1,
      turnId: TURN_1,
      ordinal: 1,
    });
    expect(state.nextAudioSequence).toBe(0x1_0000_0000);
    expectProtocolError(() => reduceMistralConversationMissionState(state, {
      type: 'TURN_STARTED',
      clientTurnId: CLIENT_TURN_2,
      turnId: TURN_2,
      ordinal: 2,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      firstAudioSequence: 0,
      ...TURN_2_VAD,
    }), 'invalid_state_transition');
  });
});

describe('Bob Mistral conversation v2 — machine de tour', () => {
  it('parcourt toutes les phases sans saut et conserve les preuves audio/VAD', () => {
    let state = acceptedTurn(10);
    state = reduceMistralConversationTurnState(state, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 10, audioBytes: 640,
    });
    state = reduceMistralConversationTurnState(state, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 11, audioBytes: 320,
    });
    state = reduceMistralConversationTurnState(state, {
      type: 'COMMIT', lastAudioSequence: 11, vadEndedAtMs: 1_400,
    });
    state = reduceMistralConversationTurnState(state, { type: 'START_TRANSCRIPTION' });
    state = reduceMistralConversationTurnState(state, { type: 'START_REASONING' });
    state = reduceMistralConversationTurnState(state, { type: 'START_RENDERING' });
    state = reduceMistralConversationTurnState(state, { type: 'START_DELIVERY' });
    state = reduceMistralConversationTurnState(state, { type: 'COMPLETE' });
    expect(state).toMatchObject({
      phase: 'completed',
      audioBytes: 960,
      firstAudioSequence: 10,
      lastAudioSequence: 11,
      nextAudioSequence: 12,
      vadEndedAtMs: 1_400,
    });
  });

  it('rend ACCEPT, COMMIT et les phases identiques idempotents', () => {
    const accepted = acceptedTurn();
    expect(reduceMistralConversationTurnState(accepted, {
      type: 'ACCEPT',
      turnId: TURN_1,
      ordinal: 1,
      cancellationGeneration: 0,
      firstAudioSequence: 0,
    })).toBe(accepted);
    let state = reduceMistralConversationTurnState(accepted, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    });
    state = reduceMistralConversationTurnState(state, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 1_200,
    });
    expect(reduceMistralConversationTurnState(state, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 1_200,
    })).toBe(state);
    state = reduceMistralConversationTurnState(state, { type: 'START_TRANSCRIPTION' });
    expect(reduceMistralConversationTurnState(state, { type: 'START_TRANSCRIPTION' })).toBe(state);
  });

  it('rejette doublon, trou, mauvais ordinal et wrap audio', () => {
    const state = reduceMistralConversationTurnState(acceptedTurn(42), {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 42, audioBytes: 320,
    });
    for (const event of [
      { type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 42, audioBytes: 320 },
      { type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 44, audioBytes: 320 },
      { type: 'AUDIO_INGESTED', ordinal: 2, audioSequence: 43, audioBytes: 320 },
    ] as const) {
      expectProtocolError(() => reduceMistralConversationTurnState(state, event), 'sequence_error');
    }
    const atEnd = reduceMistralConversationTurnState(acceptedTurn(0xffff_ffff), {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0xffff_ffff, audioBytes: 320,
    });
    expect(atEnd.nextAudioSequence).toBe(0x1_0000_0000);
    expectProtocolError(() => reduceMistralConversationTurnState(atEnd, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    }), 'sequence_error');
  });

  it('borne chaque frame et le budget cumulé du tour', () => {
    const accepted = acceptedTurn();
    expectProtocolError(() => reduceMistralConversationTurnState(accepted, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 321,
    }), 'invalid_frame');
    const almostFull: MistralConversationTurnState = {
      ...accepted,
      audioBytes: MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES - 320,
    };
    expectProtocolError(() => reduceMistralConversationTurnState(almostFull, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 640,
    }), 'audio_budget_exceeded');
  });

  it('refuse commit vide, séquence divergente et endpoint VAD impossible', () => {
    const accepted = acceptedTurn();
    expectProtocolError(() => reduceMistralConversationTurnState(accepted, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 1_200,
    }), 'invalid_state_transition');
    const withAudio = reduceMistralConversationTurnState(accepted, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    });
    expectProtocolError(() => reduceMistralConversationTurnState(withAudio, {
      type: 'COMMIT', lastAudioSequence: 1, vadEndedAtMs: 1_200,
    }), 'sequence_error');
    expectProtocolError(() => reduceMistralConversationTurnState(withAudio, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 999,
    }), 'invalid_state_transition');
    expectProtocolError(() => reduceMistralConversationTurnState(withAudio, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 121_001,
    }), 'invalid_state_transition');
  });

  it('refuse les sauts et retours de phase', () => {
    let state = reduceMistralConversationTurnState(acceptedTurn(), {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    });
    state = reduceMistralConversationTurnState(state, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 1_200,
    });
    expectProtocolError(() => reduceMistralConversationTurnState(state, { type: 'START_REASONING' }), 'invalid_state_transition');
    state = reduceMistralConversationTurnState(state, { type: 'START_TRANSCRIPTION' });
    state = reduceMistralConversationTurnState(state, { type: 'START_REASONING' });
    expectProtocolError(() => reduceMistralConversationTurnState(state, { type: 'START_TRANSCRIPTION' }), 'invalid_state_transition');
  });

  it('annule depuis toute phase, rend le replay idempotent et invalide les événements tardifs', () => {
    let state = acceptedTurn();
    const request = {
      type: 'REQUEST_CANCEL',
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
      reason: 'barge_in',
    } as const;
    state = reduceMistralConversationTurnState(state, request);
    expect(state.phase).toBe('cancel_requested');
    expect(reduceMistralConversationTurnState(state, request)).toBe(state);
    expectProtocolError(() => reduceMistralConversationTurnState(state, {
      ...request,
      cancellationId: CANCELLATION_2,
    }), 'cancellation_conflict');
    expectProtocolError(() => reduceMistralConversationTurnState(state, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    }), 'stale_after_cancellation');
    state = reduceMistralConversationTurnState(state, {
      type: 'CONFIRM_CANCEL',
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    });
    expect(state.phase).toBe('cancelled');
    expect(reduceMistralConversationTurnState(state, {
      type: 'CONFIRM_CANCEL',
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
    })).toBe(state);
    expectProtocolError(() => reduceMistralConversationTurnState(state, { type: 'COMPLETE' }), 'stale_after_cancellation');
  });

  it('interdit annulation après completion et génération sautée', () => {
    const created = createMistralConversationTurnState(startControl());
    expectProtocolError(() => reduceMistralConversationTurnState(created, {
      type: 'REQUEST_CANCEL',
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 2,
      reason: 'user',
    }), 'cancellation_conflict');

    let completed = acceptedTurn();
    completed = reduceMistralConversationTurnState(completed, {
      type: 'AUDIO_INGESTED', ordinal: 1, audioSequence: 0, audioBytes: 320,
    });
    completed = reduceMistralConversationTurnState(completed, {
      type: 'COMMIT', lastAudioSequence: 0, vadEndedAtMs: 1_200,
    });
    completed = reduceMistralConversationTurnState(completed, { type: 'START_TRANSCRIPTION' });
    completed = reduceMistralConversationTurnState(completed, { type: 'START_REASONING' });
    completed = reduceMistralConversationTurnState(completed, { type: 'START_RENDERING' });
    completed = reduceMistralConversationTurnState(completed, { type: 'START_DELIVERY' });
    completed = reduceMistralConversationTurnState(completed, { type: 'COMPLETE' });
    expectProtocolError(() => reduceMistralConversationTurnState(completed, {
      type: 'REQUEST_CANCEL',
      cancellationId: CANCELLATION_1,
      cancellationGeneration: 1,
      reason: 'user',
    }), 'invalid_state_transition');
  });
});
