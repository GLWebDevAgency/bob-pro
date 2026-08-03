import type {
  RealtimeAgentMissionSession,
  RealtimeVoiceControlReference,
} from '@bob/api-client';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessAudioLease } from '../audio';
import type {
  RealtimeAuditedSpeechPlayerDependencies,
  RealtimeAuditedSpeechPlayerEvent,
} from './realtime-audited-speech-player';
import {
  RealtimeAuditedConversationTransport,
  type RealtimeAuditedUplinkTransport,
} from './realtime-audited-conversation-transport';
import type {
  RealtimeClientDiagnosticUpdate,
  RealtimeTransportEvent,
  RealtimeTransportMetrics,
  RealtimeTransportState,
} from './realtime-transport';
import type { RealtimePublishedContextFence } from './realtime-control-gate';

const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000002';
const ACK = '00000000-0000-4000-8000-000000000003';
const DIGEST = 'a'.repeat(64);
const LEASE: ProcessAudioLease = Object.freeze({
  generation: 1,
  mode: 'realtime',
  owner: 'test-uplink',
  token: Symbol('audited-uplink-test'),
});
const POLICY = Object.freeze({
  mode: 'signed-url-v1' as const,
  allowedOrigin: 'https://project.supabase.co',
  allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${SESSION}/`,
});

const METRICS: RealtimeTransportMetrics = {
  permissionToTrackMs: null,
  offerToAnswerMs: null,
  connectToDataChannelOpenMs: null,
  sessionReadyMs: null,
  speechStoppedEventToFirstAudioSignalMs: null,
  speechStoppedToFirstInboundRtpMs: null,
  bargeInToAudioClearedMs: null,
  reconnectCount: 0,
  roundTripTimeMs: null,
  jitterMs: null,
  packetsLost: null,
};

class FakeUplink implements RealtimeAuditedUplinkTransport {
  readonly capabilities = { fullDuplex: true, bargeIn: true, remoteAudio: false };
  state: RealtimeTransportState = {
    phase: 'idle',
    generation: 1,
    turn: 0,
    fallbackReason: null,
  };
  readonly log: string[] = [];
  readonly listeners = new Set<(event: RealtimeTransportEvent) => void>();
  completesConversationAfterAuditedSpeech: boolean = false;
  sessionHandle: string | null = SESSION;
  lease: ProcessAudioLease | null = LEASE;
  policy = POLICY as typeof POLICY | null;
  emitCommitOnFinish = false;
  missionSession: RealtimeAgentMissionSession | null = null;

  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'state', state: this.state });
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.log.push('uplink:connect');
    this.emit({
      type: 'state',
      state: { ...this.state, phase: 'ready' },
    });
  }

  sendUserText(): boolean { return true; }
  setMicrophoneEnabled(enabled: boolean): void { this.log.push(`mic:${enabled}`); }
  async synchronizePublishedContext(fence: RealtimePublishedContextFence): Promise<boolean> {
    this.log.push(`context:r${fence.contextRevision}`);
    return true;
  }
  async finishUserInput(): Promise<boolean> {
    this.log.push('uplink:finish');
    if (this.emitCommitOnFinish) {
      this.emit({ type: 'user_input_committed', turnId: TURN });
    }
    return true;
  }
  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean {
    this.log.push(`uplink:interrupt:${reason}`);
    return false;
  }
  async close(reason: string): Promise<void> { this.log.push(`uplink:close:${reason}`); }
  getSessionHandle(): string | null { return this.sessionHandle; }
  takeAgentMissionSession(): RealtimeAgentMissionSession | null {
    const session = this.missionSession;
    this.missionSession = null;
    return session;
  }
  reportClientDiagnostic(update: RealtimeClientDiagnosticUpdate): void {
    this.log.push(update.type === 'checkpoint'
      ? `diagnostic:checkpoint:${update.checkpoint}`
      : `diagnostic:failure:${update.failureCode}`);
  }
  getProcessAudioLease(): ProcessAudioLease | null { return this.lease; }
  getSpeechSourcePolicy() { return this.policy; }
  metricsSnapshot(): RealtimeTransportMetrics { return METRICS; }

  emit(event: RealtimeTransportEvent): void {
    if (event.type === 'state') this.state = event.state;
    for (const listener of this.listeners) listener(event);
  }
}

function harness(input: {
  readonly oneShot?: boolean;
  readonly emitCommitOnFinish?: boolean;
  readonly createPlaybackFails?: boolean;
} = {}) {
  const uplink = new FakeUplink();
  uplink.completesConversationAfterAuditedSpeech = input.oneShot === true;
  uplink.emitCommitOnFinish = input.emitCommitOnFinish === true;
  const playerListeners = new Set<(event: RealtimeAuditedSpeechPlayerEvent) => void>();
  const log = uplink.log;
  let dependencies: RealtimeAuditedSpeechPlayerDependencies | null = null;
  const player = {
    start: vi.fn(async () => { log.push('player:start'); }),
    interrupt: vi.fn(async (reason: string) => { log.push(`player:interrupt:${reason}`); }),
    close: vi.fn(async () => { log.push('player:close'); }),
    subscribe: vi.fn((listener: (event: RealtimeAuditedSpeechPlayerEvent) => void) => {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    }),
  };
  const transport = new RealtimeAuditedConversationTransport(uplink, {
    client: {
      getNextRealtimeVoiceSpeech: vi.fn(),
      acknowledgeRealtimeVoiceSpeechDelivery: vi.fn(),
      cancelRealtimeVoiceSpeech: vi.fn(),
    } as never,
    currentFence: () => ({
      sessionHandle: SESSION,
      contextRevision: 1,
      contextDigest: DIGEST,
    }),
    createIdentifier: () => ACK,
    createPlayback: (playbackInput) => {
      expect(playbackInput).toEqual({ audioLease: LEASE, speechSourcePolicy: POLICY });
      if (input.createPlaybackFails === true) throw new Error('native_player_unavailable');
      return {} as never;
    },
    createPlayer: (input) => {
      dependencies = input;
      return player;
    },
  });
  return {
    uplink,
    player,
    transport,
    log,
    getDependencies: () => dependencies,
    emitPlayer: (event: RealtimeAuditedSpeechPlayerEvent) => {
      for (const listener of playerListeners) listener(event);
    },
  };
}

describe('RealtimeAuditedConversationTransport', () => {
  it('ne publie READY qu’après composition du player audité et conserve le bootstrap exact', async () => {
    const value = harness();
    const phases: string[] = [];
    value.transport.subscribe((event) => {
      if (event.type === 'state') phases.push(event.state.phase);
    });

    await value.transport.connect();

    expect(value.log).toEqual([
      'uplink:connect',
      'diagnostic:checkpoint:audited_player_created',
      'player:start',
    ]);
    expect(phases.at(-1)).toBe('ready');
    expect(value.getDependencies()).toMatchObject({ sessionHandle: SESSION });
    expect(value.transport.capabilities).toEqual({
      fullDuplex: true,
      bargeIn: true,
      remoteAudio: true,
    });
    expect(value.transport.completionMode).toBe('continuous');
  });

  it('attribue un échec synchrone de création du player avant le hangup', async () => {
    const value = harness({ createPlaybackFails: true });

    await expect(value.transport.connect()).rejects.toMatchObject({
      reason: 'bootstrap_failed',
    });

    expect(value.log).toEqual([
      'uplink:connect',
      'diagnostic:failure:audited_player_creation_failed',
      'uplink:close:fallback',
    ]);
  });

  it('attribue l’événement d’erreur du player de production avant le fallback', async () => {
    const value = harness();
    const events: RealtimeTransportEvent[] = [];
    value.transport.subscribe((event) => events.push(event));
    await value.transport.connect();

    value.emitPlayer({ type: 'error', code: 'playback_failed', atMs: 10 });

    expect(value.log).toContain('diagnostic:failure:audited_player_runtime_failed');
    expect(events).toContainEqual({
      type: 'error',
      code: 'audited_speech_playback_failed',
    });
    expect(events).toContainEqual({ type: 'fallback', reason: 'provider_error' });
  });

  it('relaie la capability opaque exactement une fois sans la copier dans le wrapper', () => {
    const value = harness();
    const session = { dispose: vi.fn() } as unknown as RealtimeAgentMissionSession;
    value.uplink.missionSession = session;

    expect(value.transport.takeAgentMissionSession()).toBe(session);
    expect(value.transport.takeAgentMissionSession()).toBeNull();
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('coupe localement Bob avant de publier la parole utilisateur puis relaie seulement l’ACK acoustique', async () => {
    const value = harness();
    const observed: string[] = [];
    value.transport.subscribe((event) => {
      if (event.type === 'state') {
        observed.push(`state:${event.state.phase}`);
        if (event.state.phase === 'user_speaking') value.log.push('observer:user_speaking');
      }
      if (event.type === 'agent_control_candidate') {
        observed.push(`control:${'acknowledgementId' in event.reference}`);
      }
    });
    await value.transport.connect();
    value.emitPlayer({ type: 'speech_started', sequence: 1, atMs: 10 });
    value.uplink.emit({
      type: 'state',
      state: { ...value.uplink.state, phase: 'user_speaking' },
    });
    const control: RealtimeVoiceControlReference = {
      turnId: TURN,
      acknowledgementId: ACK,
      contextRevision: 1,
      contextDigest: DIGEST,
    };
    value.emitPlayer({ type: 'control_candidate', reference: control, atMs: 11 });

    const interruptIndex = value.log.indexOf('player:interrupt:barge_in');
    expect(interruptIndex).toBeGreaterThan(-1);
    expect(interruptIndex).toBeLessThan(value.log.indexOf('observer:user_speaking'));
    expect(observed).toContain('state:user_speaking');
    expect(observed).toContain('control:true');
    expect(value.player.interrupt).toHaveBeenCalledOnce();
  });

  it('rejette toute sortie provider et déclenche un repli sans relayer son contrôle', async () => {
    const value = harness();
    const events: RealtimeTransportEvent[] = [];
    value.transport.subscribe((event) => events.push(event));
    await value.transport.connect();
    value.uplink.emit({
      type: 'agent_control_candidate',
      reference: { turnId: TURN, contextRevision: 1, contextDigest: DIGEST },
    });

    expect(events).toContainEqual({ type: 'error', code: 'provider_downlink_rejected' });
    expect(events).toContainEqual({ type: 'fallback', reason: 'provider_error' });
    expect(events.filter((event) => event.type === 'agent_control_candidate')).toHaveLength(0);
  });

  it('ferme dans l’ordre micro → player/feed → uplink/hangup', async () => {
    const value = harness();
    await value.transport.connect();

    await value.transport.close('background');

    expect(value.log.slice(-3)).toEqual([
      'mic:false',
      'player:close',
      'uplink:close:background',
    ]);
  });

  it('synchronise la fence WSS et garde le micro coupé pendant toute sortie auditée', async () => {
    const value = harness();
    await value.transport.connect();
    await expect(value.transport.synchronizePublishedContext({
      sessionHandle: SESSION,
      contextRevision: 2,
      contextDigest: DIGEST,
    })).resolves.toBe(true);
    value.transport.setMicrophoneEnabled(true);
    value.emitPlayer({ type: 'speech_started', sequence: 1, atMs: 10 });
    value.transport.setMicrophoneEnabled(true);
    value.emitPlayer({ type: 'speech_completed', sequence: 1, atMs: 11 });

    expect(value.log).toEqual([
      'uplink:connect',
      'diagnostic:checkpoint:audited_player_created',
      'player:start',
      'context:r2',
      'mic:true',
      'mic:false',
      'mic:true',
    ]);
  });

  it('conserve l’uplink et son lease si le player ne confirme pas son arrêt', async () => {
    const value = harness();
    await value.transport.connect();
    value.player.close.mockRejectedValueOnce(
      Object.assign(new Error('output still active'), { code: 'playback_stop_unconfirmed' }),
    );

    await expect(value.transport.close('fallback')).rejects.toMatchObject({
      code: 'playback_stop_unconfirmed',
    });
    expect(value.log).toContain('mic:false');
    expect(value.log).not.toContain('uplink:close:fallback');

    await expect(value.transport.close('fallback')).resolves.toBeUndefined();
    expect(value.player.close).toHaveBeenCalledTimes(2);
    expect(value.log).toContain('uplink:close:fallback');
  });

  it('relaie le commit semi-duplex et clôt un tour one-shot après le candidat acoustique', async () => {
    const value = harness({ oneShot: true });
    const events: string[] = [];
    value.transport.subscribe((event) => {
      if (event.type === 'agent_control_candidate') events.push('control');
      if (event.type === 'turn_settled') events.push(`settled:${event.status}`);
      if (event.type === 'conversation_completed') events.push('completed');
    });
    await value.transport.connect();
    expect(value.transport.completionMode).toBe('one-shot');
    await expect(value.transport.finishUserInput()).resolves.toBe(true);
    value.uplink.emit({ type: 'user_input_committed', turnId: TURN });
    expect(value.log).toContain('uplink:finish');

    const control: RealtimeVoiceControlReference = {
      turnId: TURN,
      acknowledgementId: ACK,
      contextRevision: 1,
      contextDigest: DIGEST,
    };
    value.emitPlayer({ type: 'speech_started', sequence: 1, atMs: 10 });
    value.emitPlayer({ type: 'speech_completed', sequence: 1, atMs: 11 });
    value.emitPlayer({ type: 'control_candidate', reference: control, atMs: 11 });
    value.emitPlayer({ type: 'turn_terminal', turnId: TURN, status: 'done', atMs: 11 });
    await Promise.resolve();

    expect(events).toEqual(['control', 'settled:done', 'completed']);
  });

  it('dégrade une réponse one-shot qui ne produit aucun son audité dans le budget', async () => {
    vi.useFakeTimers();
    try {
      const value = harness({ oneShot: true });
      const events: RealtimeTransportEvent[] = [];
      value.transport.subscribe((event) => events.push(event));
      await value.transport.connect();
      await value.transport.finishUserInput();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(events).toContainEqual({ type: 'error', code: 'audited_speech_response_timeout' });
      expect(events.filter((event) => event.type === 'fallback')).toEqual([
        { type: 'fallback', reason: 'provider_error' },
      ]);
      expect(value.log).toContain('diagnostic:failure:audited_pipeline_failed');
      await value.transport.close('fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('arme le watchdog sur le commit VAD autoritatif sans appel manuel', async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      const events: RealtimeTransportEvent[] = [];
      value.transport.subscribe((event) => events.push(event));
      await value.transport.connect();

      value.uplink.emit({ type: 'user_input_committed', turnId: TURN });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(events).toContainEqual({ type: 'user_input_committed', turnId: TURN });
      expect(events).toContainEqual({ type: 'turn_settled', turnId: TURN, status: 'failed' });
      expect(events).toContainEqual({ type: 'error', code: 'audited_speech_response_timeout' });
      await value.transport.close('fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuse un terminal audité sans commit correspondant et ne fabrique aucun succès', async () => {
    const value = harness();
    const events: RealtimeTransportEvent[] = [];
    value.transport.subscribe((event) => events.push(event));
    await value.transport.connect();

    value.emitPlayer({ type: 'turn_terminal', turnId: TURN, status: 'done', atMs: 10 });

    expect(events).not.toContainEqual({
      type: 'turn_settled',
      turnId: TURN,
      status: 'done',
    });
    expect(events).toContainEqual({
      type: 'error',
      code: 'audited_speech_turn_terminal_conflict',
    });
    expect(events).toContainEqual({ type: 'fallback', reason: 'provider_error' });
    expect(value.log).toContain('diagnostic:failure:audited_pipeline_failed');
  });

  it('déduplique un terminal identique et ferme sur un statut contradictoire', async () => {
    const value = harness();
    const events: RealtimeTransportEvent[] = [];
    value.transport.subscribe((event) => events.push(event));
    await value.transport.connect();
    value.uplink.emit({ type: 'user_input_committed', turnId: TURN });

    value.emitPlayer({ type: 'turn_terminal', turnId: TURN, status: 'cancelled', atMs: 10 });
    value.emitPlayer({ type: 'turn_terminal', turnId: TURN, status: 'cancelled', atMs: 11 });
    value.emitPlayer({ type: 'turn_terminal', turnId: TURN, status: 'done', atMs: 12 });

    expect(events.filter((event) => event.type === 'turn_settled')).toEqual([
      { type: 'turn_settled', turnId: TURN, status: 'cancelled' },
    ]);
    expect(events).toContainEqual({
      type: 'error',
      code: 'audited_speech_turn_terminal_conflict',
    });
  });

  it('ne double pas le watchdog quand finishUserInput relaie aussi le commit autoritatif', async () => {
    vi.useFakeTimers();
    try {
      const value = harness({ emitCommitOnFinish: true });
      await value.transport.connect();

      await expect(value.transport.finishUserInput()).resolves.toBe(true);

      expect(vi.getTimerCount()).toBe(1);
      expect(value.log.filter((entry) => entry === 'uplink:finish')).toHaveLength(1);
      await value.transport.close('user');
    } finally {
      vi.useRealTimers();
    }
  });

  it('conserve le watchdog lorsqu’une interruption à vide n’est pas acquise', async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      const events: RealtimeTransportEvent[] = [];
      value.transport.subscribe((event) => events.push(event));
      await value.transport.connect();
      value.uplink.emit({
        type: 'state',
        state: { ...value.uplink.state, phase: 'user_speaking' },
      });
      value.uplink.emit({
        type: 'state',
        state: { ...value.uplink.state, phase: 'ready' },
      });
      expect(vi.getTimerCount()).toBe(0);

      value.uplink.emit({ type: 'user_input_committed', turnId: TURN });
      expect(vi.getTimerCount()).toBe(1);

      value.transport.interrupt('navigation');
      value.uplink.emit({
        type: 'state',
        state: { ...value.uplink.state, phase: 'ready' },
      });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(events).toContainEqual({
        type: 'turn_settled',
        turnId: TURN,
        status: 'failed',
      });
      expect(events).toContainEqual({
        type: 'error',
        code: 'audited_speech_response_timeout',
      });
      await value.transport.close('navigation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('borne aussi une réponse continue qui ne produit aucun son audité', async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      const events: RealtimeTransportEvent[] = [];
      value.transport.subscribe((event) => events.push(event));
      await value.transport.connect();
      value.transport.setMicrophoneEnabled(true);
      await value.transport.finishUserInput();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(events).toContainEqual({ type: 'error', code: 'audited_speech_response_timeout' });
      expect(value.log.at(-1)).toBe('mic:false');
      await value.transport.close('fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('échoue fermé et raccroche si le bootstrap ne fournit pas la policy audio', async () => {
    const value = harness();
    value.uplink.policy = null;

    await expect(value.transport.connect()).rejects.toMatchObject({ reason: 'bootstrap_failed' });
    expect(value.log).toContain('uplink:close:fallback');
    expect(value.player.start).not.toHaveBeenCalled();
  });
});
