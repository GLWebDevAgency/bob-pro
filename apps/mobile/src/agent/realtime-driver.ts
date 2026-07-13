/**
 * REALTIME DRIVER (BOB LIVE, pièce Claude du contrat monobrain 13/07 19:09) — le pilote
 * côté session qui consomme VoiceConversationTransport (lane GPT). EXCLUSIF avec le pilote
 * legacy : quand le temps réel est actif, AUCUN askBob/useSpeak historique ne tourne.
 *
 * Découpage TESTABLE (aucun React ici) :
 * · RealtimeContextPublisher — publie snapshotAgentContext APRÈS connect et AVANT micro,
 *   révision MONOTONE, fence anti-course (jamais de publication après close, jamais une
 *   ancienne révision qui double une récente) ;
 * · decideAgentControl — l'événement agent_control ne peut QUE : naviguer via l'allowlist
 *   (jamais une route forgée) ou demander une VALIDATION VISUELLE (une proposition ne se
 *   confirme JAMAIS financièrement à la seule voix — plancher) ;
 * · mapTransportPhase — phases transport → phases de session (UI unique).
 * La glue React (AgentSessionProvider) n'orchestre que ces pièces.
 */
import {
  isAllowedAgentNavigationRoute,
  type AgentContext,
} from '@bob/ai';
import type { AppError, Result } from '@bob/core';
import type { RealtimeAgentControl } from '../realtime/realtime-event-codecs';
import type { RealtimeTransportPhase } from '../realtime/realtime-transport';

// ────────────────────────────── Publication de contexte ──────────────────────────────

export interface RealtimeVoiceContextUpdateInput {
  readonly version: 1;
  readonly revision: number;
  readonly context: AgentContext;
}

export type RealtimeContextUpdateFn = (
  sessionHandle: string,
  update: RealtimeVoiceContextUpdateInput,
) => Promise<Result<unknown, AppError>>;

/**
 * Révisions MONOTONES + fence : une publication partie avant close/une révision plus
 * récente n'écrase jamais l'état côté serveur (le serveur rejette revision ≤ courante,
 * et le publieur n'émet plus rien après close()).
 */
export class RealtimeContextPublisher {
  private revision = 0;
  private closed = false;
  private inFlight: AbortController | null = null;

  constructor(
    private readonly sessionHandle: string,
    private readonly update: RealtimeContextUpdateFn,
  ) {}

  /** Publie un instantané du contexte focalisé — l'appelant fournit un contexte DÉJÀ
   * passé par snapshotAgentContext (le driver reste pur, sans dépendance React/expo). */
  async publish(context: AgentContext): Promise<number | null> {
    if (this.closed) return null;
    this.inFlight?.abort();
    const abort = new AbortController();
    this.inFlight = abort;
    this.revision += 1;
    const revision = this.revision;
    const result = await this.update(this.sessionHandle, { version: 1, revision, context });
    if (abort.signal.aborted || this.closed) return null; // une course perdue ne compte pas
    return result.ok ? revision : null;
  }

  close(): void {
    this.closed = true;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  get currentRevision(): number {
    return this.revision;
  }
}

// ────────────────────────────── Décision agent_control ──────────────────────────────

export type AgentControlDecision =
  | { readonly kind: 'navigate'; readonly route: string }
  | { readonly kind: 'review'; readonly proposalId: string | null }
  | { readonly kind: 'none' };

/**
 * Un agent_control ne peut produire QUE deux effets côté client :
 * · navigation ALLOWLISTÉE (une route hors liste est ignorée, jamais « corrigée ») ;
 * · demande de VALIDATION VISUELLE pour une proposition — le plancher : aucune confirmation
 *   financière à la seule voix, le CTA « Continuer dans l'Assistant »/écran tranche.
 */
export function decideAgentControl(control: RealtimeAgentControl): AgentControlDecision {
  if (control.kind === 'proposed') {
    return { kind: 'review', proposalId: control.proposalId ?? null };
  }
  if (control.navigate !== undefined && isAllowedAgentNavigationRoute(control.navigate)) {
    return { kind: 'navigate', route: control.navigate };
  }
  return { kind: 'none' };
}

// ────────────────────────────── Mapping de phases ──────────────────────────────

export type RealtimeSessionPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

const PHASE_MAP: Readonly<Record<RealtimeTransportPhase, RealtimeSessionPhase>> = {
  idle: 'idle',
  authorizing: 'thinking',
  connecting: 'thinking',
  ready: 'listening',
  user_speaking: 'listening',
  bob_speaking: 'speaking',
  degraded: 'thinking',
  closing: 'idle',
  closed: 'idle',
};

export function mapTransportPhase(phase: RealtimeTransportPhase): RealtimeSessionPhase {
  return PHASE_MAP[phase];
}
