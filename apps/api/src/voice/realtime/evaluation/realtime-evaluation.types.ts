import type { RealtimeVoiceTransport } from '../realtime.types';

export type RealtimeEvaluationTransport = RealtimeVoiceTransport;

export type GroundedValue = string | number | boolean | null;

/** Fait structuré exposé par l'instrumentation, jamais extrait librement du texte par heuristique. */
export interface RealtimeGroundedFact {
  readonly key: string;
  readonly value: GroundedValue;
}

export type RealtimeSemanticKind =
  | 'answer'
  | 'navigate'
  | 'proposed'
  | 'clarify'
  | 'cancelled'
  | 'failed';

export interface RealtimeSemanticOutcome {
  readonly state: 'completed' | 'awaiting_confirmation' | 'clarification' | 'cancelled' | 'failed';
  readonly kind: RealtimeSemanticKind;
  /** Identifiant métier stable, indépendant du fournisseur audio. */
  readonly intent: string;
  readonly canonicalSpeech: string;
  readonly groundedFacts: readonly RealtimeGroundedFact[];
  readonly navigationRoute?: string;
  readonly proposedAction?: string;
}

interface RealtimeTraceEventBase {
  /** Temps monotone relatif au début du tour. Il ne s'agit pas d'une horloge murale. */
  readonly atMs: number;
}

export type RealtimeTraceEvent =
  | (RealtimeTraceEventBase & { readonly type: 'input_started' })
  | (RealtimeTraceEventBase & { readonly type: 'transcript_final' })
  | (RealtimeTraceEventBase & { readonly type: 'brain_completed' })
  | (RealtimeTraceEventBase & { readonly type: 'speech_ready' })
  | (RealtimeTraceEventBase & { readonly type: 'audio_started' })
  | (RealtimeTraceEventBase & { readonly type: 'audio_stopped' })
  | (RealtimeTraceEventBase & {
      readonly type: 'audio_acknowledged';
      readonly acknowledgementId: string;
    })
  | (RealtimeTraceEventBase & {
      readonly type: 'control_presented';
      readonly proposalId: string;
      readonly action: string;
    })
  | (RealtimeTraceEventBase & {
      readonly type: 'confirmation_received';
      readonly proposalId: string;
      readonly decision: 'accepted' | 'rejected';
    })
  | (RealtimeTraceEventBase & {
      readonly type: 'action_executed';
      readonly proposalId: string;
      readonly action: string;
    })
  | (RealtimeTraceEventBase & {
      readonly type: 'navigation_committed';
      readonly route: string;
    })
  | (RealtimeTraceEventBase & { readonly type: 'interruption_received' })
  | (RealtimeTraceEventBase & {
      readonly type: 'turn_cancelled';
      readonly reason: 'user' | 'interruption' | 'context_changed' | 'transport_closed';
    });

/**
 * Trace de certification déjà expurgée : aucun audio, transcript, nom de client ou secret.
 * Les identifiants de proposition/ACK ne servent qu'à vérifier les liaisons de sécurité.
 */
export interface RealtimeEvaluationTrace {
  readonly caseId: string;
  readonly transport: RealtimeEvaluationTransport;
  readonly outcome: RealtimeSemanticOutcome;
  readonly events: readonly RealtimeTraceEvent[];
}

export interface RealtimeEvaluationExpectation {
  readonly outcome: Omit<RealtimeSemanticOutcome, 'groundedFacts'>;
  /** Tout fait observé doit appartenir à cet ensemble exact. */
  readonly availableFacts: readonly RealtimeGroundedFact[];
  /** Sous-ensemble qui doit obligatoirement avoir soutenu la réponse. */
  readonly requiredFactKeys: readonly string[];
  readonly expectedActionExecution: 'never' | 'after_confirmation';
}

export interface RealtimeEvaluationCase {
  readonly id: string;
  readonly category: 'navigation' | 'contextual_read' | 'sensitive_proposal' | 'interruption' | 'ambiguity';
  readonly title: string;
  readonly utterance: string;
  readonly screen: string;
  readonly expectation: RealtimeEvaluationExpectation;
}

export interface RealtimeEvaluationIssue {
  readonly code: string;
  readonly message: string;
}

export interface RealtimeEvaluationResult {
  readonly passed: boolean;
  readonly issues: readonly RealtimeEvaluationIssue[];
}

export type RealtimeLatencyMetric =
  | 'input_to_transcript_final'
  | 'transcript_to_brain'
  | 'brain_to_speech_ready'
  | 'speech_ready_to_audio_started'
  | 'input_to_audio_started'
  | 'interruption_to_audio_stopped';

/** Les seuils sont injectés par le test ou la gate de déploiement, jamais cachés dans l'évaluateur. */
export type RealtimeLatencyBudgets = Readonly<Partial<Record<RealtimeLatencyMetric, number>>>;

export interface RealtimeLatencyMeasurement {
  readonly metric: RealtimeLatencyMetric;
  readonly observedMs: number | null;
  readonly budgetMs: number;
  readonly passed: boolean;
}

export interface RealtimeLatencyEvaluation extends RealtimeEvaluationResult {
  readonly measurements: readonly RealtimeLatencyMeasurement[];
}
