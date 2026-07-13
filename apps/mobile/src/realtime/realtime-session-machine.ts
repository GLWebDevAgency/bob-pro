import type { RealtimeFallbackReason, RealtimeTransportState } from './realtime-transport';

export type RealtimeMachineEvent =
  | { type: 'START'; generation: number }
  | { type: 'AUTHORIZED' }
  | { type: 'CONNECTED' }
  | { type: 'USER_SPEECH_STARTED' }
  | { type: 'USER_SPEECH_STOPPED' }
  | { type: 'BOB_AUDIO_STARTED' }
  | { type: 'RESPONSE_DONE' }
  | { type: 'DEGRADED'; reason: RealtimeFallbackReason }
  | { type: 'CLOSE' }
  | { type: 'CLOSED' };

export const INITIAL_REALTIME_STATE: RealtimeTransportState = {
  phase: 'idle',
  generation: 0,
  turn: 0,
  fallbackReason: null,
};

/** Machine pure : les callbacks d'une ancienne génération sont filtrés par le transport. */
export function reduceRealtimeState(
  state: RealtimeTransportState,
  event: RealtimeMachineEvent,
): RealtimeTransportState {
  switch (event.type) {
    case 'START':
      if (state.phase !== 'idle' && state.phase !== 'closed') return state;
      return { phase: 'authorizing', generation: event.generation, turn: 0, fallbackReason: null };
    case 'AUTHORIZED':
      return state.phase === 'authorizing' ? { ...state, phase: 'connecting' } : state;
    case 'CONNECTED':
      return state.phase === 'connecting' ? { ...state, phase: 'ready' } : state;
    case 'USER_SPEECH_STARTED':
      return state.phase === 'ready' || state.phase === 'bob_speaking'
        ? { ...state, phase: 'user_speaking', turn: state.turn + 1 }
        : state;
    case 'USER_SPEECH_STOPPED':
      return state.phase === 'user_speaking' ? { ...state, phase: 'ready' } : state;
    case 'BOB_AUDIO_STARTED':
      return state.phase === 'ready' ? { ...state, phase: 'bob_speaking' } : state;
    case 'RESPONSE_DONE':
      return state.phase === 'bob_speaking' || state.phase === 'ready'
        ? { ...state, phase: 'ready' }
        : state;
    case 'DEGRADED':
      return state.phase === 'closing' || state.phase === 'closed'
        ? state
        : { ...state, phase: 'degraded', fallbackReason: event.reason };
    case 'CLOSE':
      return state.phase === 'closed' ? state : { ...state, phase: 'closing' };
    case 'CLOSED':
      return { ...state, phase: 'closed' };
  }
}
