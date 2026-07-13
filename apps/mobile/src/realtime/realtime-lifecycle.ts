import { useEffect } from 'react';
import { AppState } from 'react-native';
import { processAudioSession } from '../audio';
import { shouldCloseRealtimeForAppState } from './realtime-lifecycle-policy';
import type { RealtimeResilienceOrchestrator } from './realtime-resilience-orchestrator';
import type { RealtimeCloseReason, VoiceConversationTransport } from './realtime-transport';

type LifecycleShutdown<T> = (target: T, reason: RealtimeCloseReason) => Promise<void>;

function requestShutdown<T>(
  target: T,
  reason: RealtimeCloseReason,
  shutdown: LifecycleShutdown<T>,
): void {
  void Promise.resolve().then(() => shutdown(target, reason)).catch(() => undefined);
}

function closeTransport(
  transport: VoiceConversationTransport,
  reason: RealtimeCloseReason,
): Promise<void> {
  return transport.close(reason);
}

function stopOrchestrator(
  orchestrator: RealtimeResilienceOrchestrator,
  reason: RealtimeCloseReason,
): Promise<void> {
  return orchestrator.stop(reason);
}

function useRealtimeLifecycle<T>(
  target: T | null,
  enabled: boolean,
  shutdown: LifecycleShutdown<T>,
): void {
  useEffect(() => {
    if (!target || !enabled) return undefined;
    let mounted = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (!shouldCloseRealtimeForAppState(state)) return;
      if (!processAudioSession.permissionRequestInFlight()) {
        requestShutdown(target, 'background', shutdown);
        return;
      }
      // Android peut signaler background pendant son dialogue permission. On attend sa
      // résolution, puis on revalide l'état réel avant de fermer — jamais de premier tap tué.
      void processAudioSession.waitForPermissionRequests().then(() => {
        if (mounted && AppState.currentState === 'background') {
          requestShutdown(target, 'background', shutdown);
        }
      });
    });
    return () => {
      mounted = false;
      subscription.remove();
      requestShutdown(target, 'unmount', shutdown);
    };
  }, [enabled, shutdown, target]);
}

/** Cycle de vie bas niveau, utile pour une surface possédant directement un transport. */
export function useRealtimeTransportLifecycle(
  transport: VoiceConversationTransport | null,
  enabled: boolean,
): void {
  useRealtimeLifecycle(transport, enabled, closeTransport);
}

/**
 * Cycle de vie de production : ferme toute la mission (primaire OU fallback), sans reprise
 * automatique au foreground. L'utilisateur garde ainsi le contrôle explicite du micro.
 */
export function useRealtimeResilienceLifecycle(
  orchestrator: RealtimeResilienceOrchestrator | null,
  enabled: boolean,
): void {
  useRealtimeLifecycle(orchestrator, enabled, stopOrchestrator);
}
