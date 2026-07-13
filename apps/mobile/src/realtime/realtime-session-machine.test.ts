import { describe, expect, it } from 'vitest';
import { INITIAL_REALTIME_STATE, reduceRealtimeState } from './realtime-session-machine';

describe('Bob Live — machine de session', () => {
  it('modélise un tour full-duplex puis un barge-in sans recréer la session', () => {
    let state = reduceRealtimeState(INITIAL_REALTIME_STATE, { type: 'START', generation: 1 });
    state = reduceRealtimeState(state, { type: 'AUTHORIZED' });
    state = reduceRealtimeState(state, { type: 'CONNECTED' });
    state = reduceRealtimeState(state, { type: 'USER_SPEECH_STARTED' });
    state = reduceRealtimeState(state, { type: 'USER_SPEECH_STOPPED' });
    state = reduceRealtimeState(state, { type: 'BOB_AUDIO_STARTED' });
    expect(state).toMatchObject({ phase: 'bob_speaking', generation: 1, turn: 1 });

    state = reduceRealtimeState(state, { type: 'USER_SPEECH_STARTED' });
    expect(state).toMatchObject({ phase: 'user_speaking', generation: 1, turn: 2 });
  });

  it('ignore les transitions impossibles et ferme depuis tout état actif', () => {
    const impossible = reduceRealtimeState(INITIAL_REALTIME_STATE, { type: 'BOB_AUDIO_STARTED' });
    expect(impossible).toBe(INITIAL_REALTIME_STATE);

    let state = reduceRealtimeState(INITIAL_REALTIME_STATE, { type: 'START', generation: 4 });
    state = reduceRealtimeState(state, { type: 'CLOSE' });
    state = reduceRealtimeState(state, { type: 'CLOSED' });
    expect(state).toMatchObject({ phase: 'closed', generation: 4 });
  });

  it('rend la dégradation explicite avant le fallback', () => {
    let state = reduceRealtimeState(INITIAL_REALTIME_STATE, { type: 'START', generation: 2 });
    state = reduceRealtimeState(state, { type: 'AUTHORIZED' });
    state = reduceRealtimeState(state, { type: 'DEGRADED', reason: 'ice_failed' });
    expect(state).toMatchObject({ phase: 'degraded', fallbackReason: 'ice_failed' });
  });
});
