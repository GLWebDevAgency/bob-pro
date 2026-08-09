import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bob/i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
  onIssue: null as null | ((issue: 'denied' | 'unavailable' | 'failed') => void),
  voice: {
    listening: false,
    start: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => true),
    ownsLease: vi.fn(() => false),
  },
  speakSentences: vi.fn(async () => ({ interrupted: false, failed: false })),
  stopSpeaking: vi.fn(),
  controllerStart: vi.fn(async () => 'unavailable' as const),
  controllerStop: vi.fn(async () => undefined),
  cleanup: vi.fn(),
  client: {
    confirmConversationTimeZone: vi.fn(),
    realtimeVoiceConfig: vi.fn(),
    updateRealtimeVoiceContext: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'runtime-id') }));
vi.mock('@bob/ui', () => ({ useTheme: () => ({ personality: 'direct' }) }));
vi.mock('../data/auth', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../data/client', () => ({
  useBobClient: () => runtime.client,
}));
vi.mock('../data/bob', () => ({
  makeBobAgent: () => ({ ask: vi.fn() }),
}));
vi.mock('../data/supabase', () => ({
  supabase: { auth: { refreshSession: vi.fn() } },
}));
vi.mock('../data/tenant-identity', () => ({
  confirmedTimeZoneFromAppMetadata: vi.fn(() => 'Europe/Paris'),
  detectDeviceTimeZone: vi.fn(() => 'Europe/Paris'),
}));
vi.mock('../data/voice', () => ({
  useVoiceInput: (
    _onTranscript: (text: string) => void,
    options: { onIssue?: (issue: 'denied' | 'unavailable' | 'failed') => void },
  ) => {
    runtime.onIssue = options.onIssue ?? null;
    return runtime.voice;
  },
  useSpeak: () => ({
    speak: vi.fn(),
    speakAndWait: vi.fn(),
    speakSentences: runtime.speakSentences,
    stopSpeaking: runtime.stopSpeaking,
  }),
  voiceMayActivateMicrophone: vi.fn(async () => true),
  voicePermissionRequestInFlight: vi.fn(() => false),
  waitForVoicePermissionLifecycleStabilization: vi.fn(async () => undefined),
  waitForVoicePermissionRequests: vi.fn(async () => undefined),
}));
vi.mock('./agent-context', () => ({
  snapshotAgentContext: (value: unknown) => value,
  useAgentContext: () => ({
    screen: { name: '/test', instanceId: '/test' },
    entities: [],
    capabilities: [],
  }),
  useAgentSurface: () => ({}),
}));
vi.mock('./agent-mission-provider', () => ({
  useAgentMissionRuntimeBridge: () => ({
    currentSnapshot: vi.fn(() => ({ generation: 1, realtimeSessionId: null })),
  }),
}));
vi.mock('../realtime/mistral-conversation-checkpoint-provider', () => ({
  useMistralConversationCheckpointBinding: () => null,
}));
vi.mock('../data/session-cleanup', () => ({
  registerBeforeSignOutCleanup: () => runtime.cleanup,
}));
vi.mock('./realtime-session', () => ({
  RealtimeSessionController: class {
    active = false;
    start = runtime.controllerStart;
    resumeMissionV1 = vi.fn(async () => 'failed_closed' as const);
    resumeMissionV2 = vi.fn(async () => 'failed_closed' as const);
    stop = runtime.controllerStop;
    stopForPolicy = runtime.controllerStop;
    stopAfterManualHandoff = runtime.controllerStop;
    suspendForManualHandoff = vi.fn(async () => false);
    finishUserInput = vi.fn(async () => false);
    publishContext = vi.fn(async () => false);
  },
}));
vi.mock('../realtime/realtime-control-gate', () => ({
  RealtimeControlAcknowledgementGate: class {},
}));
vi.mock('../realtime/realtime-audited-conversation-transport', () => ({
  RealtimeAuditedConversationTransport: class {},
}));
vi.mock('../realtime/realtime-conversation-transport-factory', () => ({
  composeRealtimeConversationTransport: vi.fn(),
}));
vi.mock('../realtime/expo-realtime-audited-speech-playback', () => ({
  ExpoRealtimeAuditedSpeechPlayback: class {},
}));
vi.mock('../realtime/realtime-resilience-orchestrator', () => ({
  RealtimeResilienceOrchestrator: class {},
}));
vi.mock('../realtime/webrtc-realtime-transport', () => ({ RealtimeWebRtcTransport: class {} }));
vi.mock('../realtime/mistral-realtime-transport', () => ({ MistralRealtimeTransport: class {} }));
vi.mock('../realtime/mistral-conversation-runtime', () => ({
  isRealtimeMistralConversationNegotiation: () => false,
  MistralConversationTransport: class {},
}));
vi.mock('./realtime-primary-transport', () => ({
  createRealtimePrimaryTransport: vi.fn(),
}));

import {
  AgentSessionProvider,
  useAgentSession,
  type AgentSessionValue,
} from './agent-session';

describe('AgentSessionProvider — récupération voix verticale', () => {
  let renderer: ReactTestRenderer | null = null;
  let session: AgentSessionValue | null = null;

  function Probe() {
    session = useAgentSession();
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime.onIssue = null;
    runtime.voice.listening = false;
    runtime.voice.cancel.mockResolvedValue(true);
    runtime.controllerStart.mockResolvedValue('unavailable');
    runtime.speakSentences.mockResolvedValue({ interrupted: false, failed: false });
    await act(async () => {
      renderer = create(createElement(
        AgentSessionProvider,
        null,
        createElement(Probe),
      ));
    });
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    session = null;
  });

  it('branche une panne ASR vers l’état visible puis nettoie entièrement au dismiss', () => {
    act(() => runtime.onIssue?.('failed'));
    expect(session).toMatchObject({
      active: false,
      phase: 'error',
      issue: 'failed',
      response: t('agent.global.issueFailed', { personality: 'direct' }),
    });

    act(() => session?.dismissResponse());
    expect(session).toMatchObject({
      phase: 'idle',
      issue: null,
      response: null,
      transcript: null,
      reviewRequired: false,
    });
  });

  it('rend la réponse en texte et ferme la session si la synthèse locale échoue', async () => {
    runtime.speakSentences.mockResolvedValueOnce({ interrupted: false, failed: true });
    act(() => session?.start());
    await act(async () => {
      await vi.waitFor(() => expect(runtime.controllerStart).toHaveBeenCalled());
    });
    await act(async () => {
      await vi.waitFor(() => expect(runtime.voice.cancel).toHaveBeenCalled());
    });
    await act(async () => {
      await vi.waitFor(() => expect(runtime.speakSentences).toHaveBeenCalled());
    });

    expect(runtime.voice.cancel).toHaveBeenCalled();
    expect(runtime.voice.start).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      active: false,
      phase: 'error',
      issue: 'unavailable',
      response: t('agent.global.outputUnavailable', { personality: 'direct' }),
    });
  });
});
