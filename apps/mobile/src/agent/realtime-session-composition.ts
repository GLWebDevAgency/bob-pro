import type { AgentContext } from '@bob/ai';
import type { BobClient } from '@bob/api-client';
import { randomUUID } from 'expo-crypto';

import { RealtimeAuditedConversationTransport } from '../realtime/realtime-audited-conversation-transport';
import { composeRealtimeConversationTransport } from '../realtime/realtime-conversation-transport-factory';
import { ExpoRealtimeAuditedSpeechPlayback } from '../realtime/expo-realtime-audited-speech-playback';
import {
  isRealtimeMistralConversationNegotiation,
  MistralConversationTransport,
  type MistralConversationCheckpointBinding,
} from '../realtime/mistral-conversation-runtime';
import { MistralRealtimeTransport } from '../realtime/mistral-realtime-transport';
import { RealtimeControlAcknowledgementGate } from '../realtime/realtime-control-gate';
import { RealtimeResilienceOrchestrator } from '../realtime/realtime-resilience-orchestrator';
import { RealtimeWebRtcTransport } from '../realtime/webrtc-realtime-transport';
import type { WebRtcRuntime } from '../realtime/webrtc-runtime';
import type { AgentMissionRuntimeBridge } from './agent-mission-runtime';
import { realtimeGenericReconnectBudget } from './agent-session-runtime';
import { createRealtimePrimaryTransport } from './realtime-primary-transport';
import {
  RealtimeSessionController,
  type RealtimeSessionDeps,
  type RealtimeSessionHooks,
} from './realtime-session';

export interface AgentRealtimeSessionCompositionInput {
  readonly client: BobClient;
  readonly hooks: Omit<RealtimeSessionHooks, 'getContextSnapshot'>;
  readonly agentMissionRuntime: AgentMissionRuntimeBridge;
  readonly ensureConfirmedTimeZoneForMissionV2:
    RealtimeSessionDeps['ensureConfirmedTimeZoneForMissionV2'];
  readonly confirmDiagnosticTraceBeforeListening:
    RealtimeSessionDeps['confirmDiagnosticTraceBeforeListening'];
  readonly allowMicrophoneActivation: RealtimeSessionDeps['allowMicrophoneActivation'];
  readonly getContextSnapshot: () => AgentContext;
  readonly getMistralConversationCheckpoint:
    () => MistralConversationCheckpointBinding | null;
  readonly recordMistralConversationCheckpointUsed:
    (checkpoint: MistralConversationCheckpointBinding | null) => void;
  /** Injection strictement réservée aux tests de la frontière OS WebRTC. */
  readonly loadWebRtcRuntime?: () => WebRtcRuntime | null;
}

/**
 * Composition root unique de Bob Live mobile.
 *
 * Le Provider React et les preuves verticales passent par cette même fabrique. Les transports
 * restent créés paresseusement après la négociation serveur : construire le contrôleur ne prend
 * ni micro, ni lease, ni connexion réseau.
 */
export function createAgentRealtimeSessionController(
  input: AgentRealtimeSessionCompositionInput,
): RealtimeSessionController {
  return new RealtimeSessionController(
    {
      negotiate: async () => {
        const config = await input.client.realtimeVoiceConfig();
        return config.ok ? config.value : null;
      },
      ensureConfirmedTimeZoneForMissionV2: input.ensureConfirmedTimeZoneForMissionV2,
      confirmDiagnosticTraceBeforeListening: input.confirmDiagnosticTraceBeforeListening,
      updateContext: (handle, update) => input.client.updateRealtimeVoiceContext(handle, update),
      createOrchestrator: (
        negotiation,
        agentMissionProtocolVersion,
        legacyFallback,
        currentFence,
        onPrimaryCreated,
      ) => {
        const conversationV2 = isRealtimeMistralConversationNegotiation(negotiation);
        return new RealtimeResilienceOrchestrator({
          createPrimary: () => {
            const selection = createRealtimePrimaryTransport({
              negotiation,
              checkpoint: input.getMistralConversationCheckpoint(),
              factories: {
                webRtc: (webRtcNegotiation) => new RealtimeWebRtcTransport(
                  input.client,
                  webRtcNegotiation,
                  {
                    agentMissionProtocolVersion,
                    ...(input.loadWebRtcRuntime === undefined
                      ? {}
                      : { loadRuntime: input.loadWebRtcRuntime }),
                  },
                ),
                mistralConversation: (
                  mistralConversationNegotiation,
                  checkpoint,
                ) => new MistralConversationTransport(
                  input.client,
                  mistralConversationNegotiation,
                  {
                    getInitialContext: input.getContextSnapshot,
                    checkpoint,
                  },
                ),
                mistralPcm: (mistralPcmNegotiation) => new MistralRealtimeTransport(
                  input.client,
                  mistralPcmNegotiation,
                  { getInitialContext: input.getContextSnapshot },
                ),
              },
            });
            input.recordMistralConversationCheckpointUsed(selection.checkpointUsed);
            const transport = composeRealtimeConversationTransport(
              negotiation,
              selection.uplink,
              (auditedUplink) => new RealtimeAuditedConversationTransport(auditedUplink, {
                client: input.client,
                currentFence,
                createIdentifier: randomUUID,
                createPlayback: ({ audioLease, speechSourcePolicy }) => (
                  new ExpoRealtimeAuditedSpeechPlayback({ audioLease, speechSourcePolicy })
                ),
              }),
            );
            onPrimaryCreated(transport);
            return transport;
          },
          legacyFallback,
          maxReconnectAttempts: realtimeGenericReconnectBudget(
            agentMissionProtocolVersion,
            conversationV2,
          ),
        });
      },
      createControlGate: (currentFence) => new RealtimeControlAcknowledgementGate(
        input.client,
        currentFence,
      ),
      allowMicrophoneActivation: input.allowMicrophoneActivation,
      agentMissionRuntime: input.agentMissionRuntime,
    },
    {
      ...input.hooks,
      getContextSnapshot: input.getContextSnapshot,
    },
  );
}
