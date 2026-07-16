import {
  MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES,
  MISTRAL_CONVERSATION_PROTOCOL,
  encodeMistralConversationServerEvent,
  type MistralConversationServerEvent,
} from '@bob/ai';
import { describe, expect, it } from 'vitest';

import {
  MistralConversationEventStreamError,
  MistralConversationServerEventStream,
} from './mistral-conversation-event-stream';

const SESSION_HANDLE = '00000000-0000-4000-8000-000000000101';
const CLIENT_TURN_ID = '00000000-0000-4000-8000-000000000102';
const TURN_ID = '00000000-0000-4000-8000-000000000103';
const CANCELLATION_ID = '00000000-0000-4000-8000-000000000104';
const CONTEXT_DIGEST = 'a'.repeat(64);

function ready(serverSequence = 0, sessionHandle = SESSION_HANDLE): MistralConversationServerEvent {
  return {
    type: 'session.ready',
    serverSequence,
    sessionHandle,
    missionConnectionEpoch: 1,
    expiresAt: '2026-07-15T14:00:00.000Z',
    contextRevision: 1,
    contextDigest: CONTEXT_DIGEST,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    nextAudioSequence: 0,
    maxMissionAudioBytes: 1_920_000,
  };
}

function phase(serverSequence: number): MistralConversationServerEvent {
  return {
    type: 'turn.phase',
    serverSequence,
    clientTurnId: CLIENT_TURN_ID,
    turnId: TURN_ID,
    ordinal: 1,
    phase: 'reasoning',
  };
}

function errorEvent(serverSequence: number): MistralConversationServerEvent {
  return {
    type: 'error',
    serverSequence,
    code: 'temporarily_unavailable',
    retryable: true,
  };
}

function closeEvent(serverSequence: number): MistralConversationServerEvent {
  return {
    type: 'session.closed',
    serverSequence,
    reason: 'user',
  };
}

function routeRecovering(serverSequence: number): MistralConversationServerEvent {
  return {
    type: 'session.route_recovering',
    serverSequence,
    cancellationGeneration: 1,
  };
}

function routeRecovered(serverSequence: number, missionConnectionEpoch = 2): MistralConversationServerEvent {
  return {
    type: 'session.route_recovered',
    serverSequence,
    missionConnectionEpoch,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
  };
}

function cancelled(
  serverSequence: number,
  cancellationGeneration = 1,
): MistralConversationServerEvent {
  return {
    type: 'turn.cancelled',
    serverSequence,
    clientTurnId: CLIENT_TURN_ID,
    turnId: TURN_ID,
    ordinal: 1,
    cancellationId: CANCELLATION_ID,
    cancellationGeneration,
  };
}

function wire(event: MistralConversationServerEvent): string {
  return encodeMistralConversationServerEvent(event);
}

describe('MistralConversationServerEventStream', () => {
  it('accepte ready puis les événements contigus et ignore tout replay déjà appliqué', () => {
    const stream = new MistralConversationServerEventStream();

    expect(stream.accept(wire(ready()))).toEqual({ kind: 'accepted', event: ready() });
    expect(stream.accept(wire(phase(1)))).toEqual({ kind: 'accepted', event: phase(1) });
    expect(stream.accept(wire(ready()))).toEqual({ kind: 'duplicate', serverSequence: 0 });
    expect(stream.accept(wire(phase(1)))).toEqual({ kind: 'duplicate', serverSequence: 1 });
    expect(stream.nextServerSequence).toBe(2);
    expect(stream.snapshot()).toEqual({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
    });
    expect(stream.acknowledgement()).toEqual({
      type: 'events.ack',
      missionConnectionEpoch: 1,
      nextServerSequence: 2,
    });
  });

  it('refuse un trou sans empoisonner le curseur, puis accepte la séquence réparée', () => {
    const stream = new MistralConversationServerEventStream();
    stream.accept(wire(ready()));

    expect(() => stream.accept(wire(errorEvent(2)))).toThrowError(
      expect.objectContaining({ code: 'server_sequence_gap' }),
    );
    expect(stream.nextServerSequence).toBe(1);
    expect(stream.accept(wire(phase(1))).kind).toBe('accepted');
    expect(stream.accept(wire(errorEvent(2))).kind).toBe('accepted');
  });

  it('exige session.ready en séquence zéro et interdit un second handshake', () => {
    const stream = new MistralConversationServerEventStream();
    expect(() => stream.accept(wire(errorEvent(0)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
    expect(stream.nextServerSequence).toBe(0);
    stream.accept(wire(ready()));
    expect(() => stream.accept(wire(ready(1)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
  });

  it('reprend depuis un curseur attesté, élimine l’historique rejoué puis avance', () => {
    const stream = new MistralConversationServerEventStream({
      nextServerSequence: 3,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
    });

    expect(stream.accept(wire(ready()))).toEqual({ kind: 'duplicate', serverSequence: 0 });
    expect(stream.accept(wire(phase(1)))).toEqual({ kind: 'duplicate', serverSequence: 1 });
    expect(stream.accept(wire(errorEvent(2)))).toEqual({ kind: 'duplicate', serverSequence: 2 });
    expect(stream.accept(wire(errorEvent(3))).kind).toBe('accepted');
    expect(stream.nextServerSequence).toBe(4);
  });

  it('rend la fermeture terminale, tout en tolérant les replays antérieurs', () => {
    const stream = new MistralConversationServerEventStream();
    stream.accept(wire(ready()));
    stream.accept(wire(closeEvent(1)));

    expect(stream.closed).toBe(true);
    expect(stream.accept(wire(closeEvent(1)))).toEqual({
      kind: 'duplicate',
      serverSequence: 1,
    });
    expect(() => stream.accept(wire(errorEvent(2)))).toThrowError(
      expect.objectContaining({ code: 'server_event_after_close' }),
    );
    expect(stream.snapshot()).toEqual({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      closed: true,
    });
    expect(stream.acknowledgement()).toBeNull();
  });

  it('diffère l’ACK pendant un takeover puis adopte strictement le nouvel owner', () => {
    const stream = new MistralConversationServerEventStream();
    stream.accept(wire(ready()));
    stream.accept(wire(routeRecovering(1)));
    expect(stream.acknowledgement()).toBeNull();
    stream.accept(wire(routeRecovered(2)));
    expect(stream.missionConnectionEpoch).toBe(2);
    expect(stream.acknowledgement()).toEqual({
      type: 'events.ack',
      missionConnectionEpoch: 2,
      nextServerSequence: 3,
    });

    expect(() => new MistralConversationServerEventStream({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 2,
    }).accept(wire(routeRecovered(2, 2)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
  });

  it('conserve un takeover en attente à travers le snapshot et sa reconstruction', () => {
    const stream = new MistralConversationServerEventStream();
    stream.accept(wire(ready()));
    stream.accept(wire(routeRecovering(1)));

    const snapshot = stream.snapshot();
    expect(snapshot).toEqual({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      recoveryPending: true,
      recoveryCancellationGeneration: 1,
    });

    const resumed = new MistralConversationServerEventStream(snapshot ?? undefined);
    expect(resumed.acknowledgement()).toBeNull();
    expect(resumed.accept(wire(routeRecovering(1)))).toEqual({
      kind: 'duplicate',
      serverSequence: 1,
    });
    expect(resumed.acknowledgement()).toBeNull();
    expect(resumed.accept(wire(routeRecovered(2)))).toEqual({
      kind: 'accepted',
      event: routeRecovered(2),
    });
    expect(resumed.missionConnectionEpoch).toBe(2);
    expect(resumed.acknowledgement()).toEqual({
      type: 'events.ack',
      missionConnectionEpoch: 2,
      nextServerSequence: 3,
    });
  });

  it('bloque tout événement non recovery entre route_recovering et route_recovered', () => {
    for (const hostile of [phase(2), errorEvent(2), closeEvent(2)]) {
      const stream = new MistralConversationServerEventStream();
      stream.accept(wire(ready()));
      stream.accept(wire(routeRecovering(1)));
      expect(() => stream.accept(wire(hostile))).toThrowError(
        expect.objectContaining({ code: 'invalid_server_handshake' }),
      );
      expect(stream.nextServerSequence).toBe(2);
    }
  });

  it('accepte au plus une annulation corrélée puis exige exactement epoch +1', () => {
    const stream = new MistralConversationServerEventStream();
    stream.accept(wire(ready()));
    stream.accept(wire(routeRecovering(1)));
    expect(() => stream.accept(wire(cancelled(2, 2)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
    expect(stream.accept(wire(cancelled(2)))).toEqual({ kind: 'accepted', event: cancelled(2) });
    expect(stream.snapshot()).toEqual({
      nextServerSequence: 3,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      recoveryPending: true,
      recoveryCancellationGeneration: 1,
      recoveryCancellationAccepted: true,
    });
    expect(() => stream.accept(wire(cancelled(3)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
    expect(() => stream.accept(wire(routeRecovered(3, 3)))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
    expect(stream.accept(wire(routeRecovered(3, 2))).kind).toBe('accepted');
  });

  it('lie les replays ready à la mission reprise et refuse toute équivoque', () => {
    const stream = new MistralConversationServerEventStream({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
    });
    expect(() => stream.accept(wire(ready(0, 'different_session_handle_123456')))).toThrowError(
      expect.objectContaining({ code: 'invalid_server_handshake' }),
    );
  });

  it('rejette frame non texte, JSON invalide, contrat inconnu et payload UTF-8 hors borne', () => {
    const invalidFrames: unknown[] = [
      new ArrayBuffer(8),
      '',
      '{',
      JSON.stringify({ protocol: MISTRAL_CONVERSATION_PROTOCOL }),
      JSON.stringify({ ...ready(), unexpected: true }),
      'é'.repeat(Math.floor(MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES / 2) + 1),
    ];
    for (const invalid of invalidFrames) {
      expect(() => new MistralConversationServerEventStream().accept(invalid)).toThrow(
        MistralConversationEventStreamError,
      );
    }
  });

  it('refuse un snapshot de reprise ambigu ou hors uint32', () => {
    for (const nextServerSequence of [0, -1, 1.5, 0x1_0000_0002]) {
      expect(() => new MistralConversationServerEventStream({
        nextServerSequence,
        sessionReadyAccepted: true,
        sessionHandle: SESSION_HANDLE,
        missionConnectionEpoch: 1,
      })).toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
    }
    expect(() => new MistralConversationServerEventStream({
      nextServerSequence: 1,
      sessionReadyAccepted: false,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
    } as unknown as ConstructorParameters<typeof MistralConversationServerEventStream>[0]))
      .toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
    expect(() => new MistralConversationServerEventStream({
      nextServerSequence: 1,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      unexpected: true,
    } as unknown as ConstructorParameters<typeof MistralConversationServerEventStream>[0]))
      .toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
    for (const recoveryPending of [false, null, 'true']) {
      expect(() => new MistralConversationServerEventStream({
        nextServerSequence: 2,
        sessionReadyAccepted: true,
        sessionHandle: SESSION_HANDLE,
        missionConnectionEpoch: 1,
        recoveryPending,
        recoveryCancellationGeneration: 1,
      } as unknown as ConstructorParameters<typeof MistralConversationServerEventStream>[0]))
        .toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
    }
    expect(() => new MistralConversationServerEventStream({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      closed: true,
      recoveryPending: true,
      recoveryCancellationGeneration: 1,
    })).toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
    expect(() => new MistralConversationServerEventStream({
      nextServerSequence: 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION_HANDLE,
      missionConnectionEpoch: 1,
      recoveryPending: true,
    })).toThrowError(expect.objectContaining({ code: 'invalid_server_handshake' }));
  });
});
