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

/** Réponse serveur du PUT : la révision CONFIRMÉE et le digest du contexte accepté —
 * la paire qui lie tout contrôle ultérieur au contexte réellement publié. */
export interface RealtimeContextAck {
  readonly revision: number;
  readonly contextDigest: string;
}

export type RealtimeContextUpdateFn = (
  sessionHandle: string,
  update: RealtimeVoiceContextUpdateInput,
) => Promise<Result<RealtimeContextAck, AppError>>;

export interface RealtimePublishedFence {
  readonly sessionHandle: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

/** Issue d'une publication — l'appelant DOIT distinguer les trois cas :
 * `confirmed` = fence serveur, le micro peut se rouvrir sur CE contexte ;
 * `superseded` = doublée par une publication plus récente ou publieur fermé — BÉNIN,
 *   la plus récente porte la vérité (ne jamais traiter comme un échec) ;
 * `failed` = le serveur a réellement refusé/échoué — FATAL pour la session. */
export type RealtimePublishResult =
  | { readonly status: 'confirmed'; readonly fence: RealtimePublishedFence }
  | { readonly status: 'superseded' }
  | { readonly status: 'failed' };

/**
 * Révisions MONOTONES + fence : une publication partie avant close/une révision plus
 * récente n'écrase jamais l'état côté serveur (le serveur rejette revision ≤ courante,
 * et le publieur n'émet plus rien après close()).
 */
export class RealtimeContextPublisher {
  private revision = 0;
  private closed = false;
  private inFlight: AbortController | null = null;
  private acknowledged: RealtimePublishedFence | null = null;

  constructor(
    private readonly sessionHandle: string,
    private readonly update: RealtimeContextUpdateFn,
  ) {}

  /** Publie un instantané du contexte focalisé (DÉJÀ passé par snapshotAgentContext).
   * `superseded` (fermé ou doublé par plus récent) est BÉNIN ; `failed` est un vrai échec. */
  async publish(context: AgentContext): Promise<RealtimePublishResult> {
    if (this.closed) return { status: 'superseded' };
    this.inFlight?.abort();
    // Une fence authentifie un écran précis. Dès qu'un nouvel écran part vers le serveur,
    // l'ancienne ne peut plus autoriser un contrôle en file pendant la transition.
    this.acknowledged = null;
    const abort = new AbortController();
    this.inFlight = abort;
    this.revision += 1;
    const revision = this.revision;
    const result = await this.update(this.sessionHandle, { version: 1, revision, context });
    if (abort.signal.aborted || this.closed) return { status: 'superseded' }; // course perdue — la plus récente fait foi
    if (!result.ok) return { status: 'failed' };
    if (result.value.revision !== revision) return { status: 'failed' };
    // La fence = la RÉPONSE serveur (revision confirmée + digest) — jamais nos valeurs locales :
    // c'est elle qui authentifie les contrôles one-shot liés à CE contexte.
    this.acknowledged = {
      sessionHandle: this.sessionHandle,
      contextRevision: result.value.revision,
      contextDigest: result.value.contextDigest,
    };
    return { status: 'confirmed', fence: this.acknowledged };
  }

  /** Dernière publication CONFIRMÉE — la fence que le gate d'ACK consomme. */
  get fence(): RealtimePublishedFence | null {
    return this.closed ? null : this.acknowledged;
  }

  close(): void {
    this.closed = true;
    this.inFlight?.abort();
    this.inFlight = null;
    this.acknowledged = null;
  }

  get currentRevision(): number {
    return this.revision;
  }
}

// ────────────────────────────── Décision agent_control ──────────────────────────────

export type AgentControlDecision =
  | { readonly kind: 'navigate'; readonly route: string }
  | {
      readonly kind: 'review';
      readonly proposalId: string | null;
      readonly proposalExpiresAt: string | null;
    }
  | { readonly kind: 'none' };

/**
 * Un agent_control ne peut produire QUE deux effets côté client :
 * · navigation ALLOWLISTÉE (une route hors liste est ignorée, jamais « corrigée ») ;
 * · demande de VALIDATION VISUELLE pour une proposition — le plancher : aucune confirmation
 *   financière à la seule voix, le CTA « Continuer dans l'Assistant »/écran tranche.
 */
export function decideAgentControl(control: RealtimeAgentControl): AgentControlDecision {
  if (control.kind === 'proposed') {
    return {
      kind: 'review',
      proposalId: control.proposalId ?? null,
      proposalExpiresAt: control.proposalExpiresAt ?? null,
    };
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
