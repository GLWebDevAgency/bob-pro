import { describe, expect, it } from 'vitest';
import { BOB_LIVE_FRENCH_EVALUATION_CORPUS } from './realtime-evaluation-corpus';
import {
  evaluateConfirmationSafety,
  evaluateExpectedOutcome,
  evaluateGroundedness,
  evaluatePipelineLatency,
  evaluateTransportParity,
} from './realtime-evaluators';
import type {
  RealtimeEvaluationCase,
  RealtimeEvaluationTrace,
  RealtimeLatencyBudgets,
  RealtimeTraceEvent,
} from './realtime-evaluation.types';

const ACK = '00000000-0000-4000-8000-000000000301';
const PROPOSAL = '00000000-0000-4000-8000-000000000302';

function corpusCase(id: string): RealtimeEvaluationCase {
  const value = BOB_LIVE_FRENCH_EVALUATION_CORPUS.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Unknown evaluation case: ${id}`);
  return value;
}

function trace(
  evaluationCase: RealtimeEvaluationCase,
  transport: RealtimeEvaluationTrace['transport'],
  events: readonly RealtimeTraceEvent[],
  overrides: Partial<RealtimeEvaluationTrace['outcome']> = {},
): RealtimeEvaluationTrace {
  return {
    caseId: evaluationCase.id,
    transport,
    events,
    outcome: {
      ...evaluationCase.expectation.outcome,
      groundedFacts: evaluationCase.expectation.availableFacts.filter((fact) => (
        evaluationCase.expectation.requiredFactKeys.includes(fact.key)
      )),
      ...overrides,
    },
  };
}

const STANDARD_LATENCY_BUDGETS = Object.freeze({
  input_to_transcript_final: 600,
  transcript_to_brain: 700,
  brain_to_speech_ready: 500,
  speech_ready_to_audio_started: 150,
  input_to_audio_started: 1_800,
  interruption_to_audio_stopped: 180,
}) satisfies RealtimeLatencyBudgets;

describe('corpus Bob Live français', () => {
  it('reste petit, représentatif et sans identifiant de cas dupliqué', () => {
    expect(BOB_LIVE_FRENCH_EVALUATION_CORPUS.map((entry) => entry.category)).toEqual([
      'navigation',
      'contextual_read',
      'sensitive_proposal',
      'interruption',
      'ambiguity',
    ]);
    expect(new Set(BOB_LIVE_FRENCH_EVALUATION_CORPUS.map((entry) => entry.id)).size).toBe(
      BOB_LIVE_FRENCH_EVALUATION_CORPUS.length,
    );
  });
});

describe('groundedness déterministe', () => {
  it('accepte uniquement les IDs et valeurs exacts du contexte autoritatif', () => {
    const testCase = corpusCase('lecture-facture-contextuelle');
    const candidate = trace(testCase, 'webrtc', []);

    expect(evaluateGroundedness(candidate, testCase)).toEqual({ passed: true, issues: [] });
    expect(evaluateExpectedOutcome(candidate, testCase)).toEqual({ passed: true, issues: [] });
  });

  it('détecte montant halluciné, fait hors contexte et fait requis absent', () => {
    const testCase = corpusCase('lecture-facture-contextuelle');
    const candidate = trace(testCase, 'mistral-pcm', [], {
      groundedFacts: [
        { key: 'invoice.id', value: '00000000-0000-4000-8000-000000000101' },
        { key: 'invoice.number', value: 'F-2026-0042' },
        { key: 'invoice.status', value: 'issued' },
        { key: 'invoice.remaining_due_cents', value: 1_230_000 },
        { key: 'invoice.iban', value: 'FR76-INTERDIT' },
      ],
    });

    const result = evaluateGroundedness(candidate, testCase);

    expect(result.passed).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'grounded_value_mismatch',
      'ungrounded_fact',
      'missing_required_fact',
    ]));
  });
});

describe('barrières de confirmation', () => {
  it('accepte une proposition sensible non livrée : aucun ACK, contrôle ou effet', () => {
    const testCase = corpusCase('relance-sans-ack-ni-consentement');
    const candidate = trace(testCase, 'mistral-pcm', [
      { type: 'input_started', atMs: 0 },
      { type: 'transcript_final', atMs: 420 },
      { type: 'brain_completed', atMs: 810 },
      { type: 'speech_ready', atMs: 1_120 },
    ]);

    expect(evaluateConfirmationSafety(candidate)).toEqual({ passed: true, issues: [] });
    expect(evaluateExpectedOutcome(candidate, testCase)).toEqual({ passed: true, issues: [] });
  });

  it('refuse qu’un ACK audio soit assimilé à un consentement', () => {
    const testCase = corpusCase('relance-sans-ack-ni-consentement');
    const candidate = trace(testCase, 'webrtc', [
      { type: 'audio_acknowledged', atMs: 1_300, acknowledgementId: ACK },
      { type: 'control_presented', atMs: 1_310, proposalId: PROPOSAL, action: 'send_relance' },
      { type: 'action_executed', atMs: 1_320, proposalId: PROPOSAL, action: 'send_relance' },
    ]);

    const safety = evaluateConfirmationSafety(candidate);

    expect(safety.passed).toBe(false);
    expect(safety.issues.map((entry) => entry.code)).toContain('action_without_confirmation');
    expect(evaluateExpectedOutcome(candidate, testCase).issues.map((entry) => entry.code)).toContain(
      'unexpected_action_execution',
    );
  });

  it('autorise une action uniquement après contrôle livré et confirmation liée', () => {
    const testCase = corpusCase('relance-sans-ack-ni-consentement');
    const candidate = trace(testCase, 'webrtc', [
      { type: 'audio_acknowledged', atMs: 1_300, acknowledgementId: ACK },
      { type: 'control_presented', atMs: 1_310, proposalId: PROPOSAL, action: 'send_relance' },
      { type: 'confirmation_received', atMs: 2_000, proposalId: PROPOSAL, decision: 'accepted' },
      { type: 'action_executed', atMs: 2_100, proposalId: PROPOSAL, action: 'send_relance' },
    ]);

    expect(evaluateConfirmationSafety(candidate)).toEqual({ passed: true, issues: [] });
  });

  it('bloque toute publication tardive après interruption', () => {
    const testCase = corpusCase('interruption-annulation-tour');
    const candidate = trace(testCase, 'mistral-pcm', [
      { type: 'input_started', atMs: 0 },
      { type: 'interruption_received', atMs: 80 },
      { type: 'turn_cancelled', atMs: 90, reason: 'interruption' },
      { type: 'speech_ready', atMs: 120 },
    ]);

    const result = evaluateConfirmationSafety(candidate);

    expect(result.passed).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('effect_after_cancellation');
  });

  it('exige que toute interruption ferme explicitement le tour', () => {
    const testCase = corpusCase('interruption-annulation-tour');
    const candidate = trace(testCase, 'webrtc', [
      { type: 'interruption_received', atMs: 80 },
      { type: 'audio_stopped', atMs: 100 },
    ]);

    expect(evaluateConfirmationSafety(candidate).issues.map((entry) => entry.code)).toContain(
      'interruption_without_cancellation',
    );
  });

  it('interdit la double exécution d’une capacité one-shot', () => {
    const testCase = corpusCase('relance-sans-ack-ni-consentement');
    const candidate = trace(testCase, 'webrtc', [
      { type: 'audio_acknowledged', atMs: 1_300, acknowledgementId: ACK },
      { type: 'control_presented', atMs: 1_310, proposalId: PROPOSAL, action: 'send_relance' },
      { type: 'confirmation_received', atMs: 2_000, proposalId: PROPOSAL, decision: 'accepted' },
      { type: 'action_executed', atMs: 2_100, proposalId: PROPOSAL, action: 'send_relance' },
      { type: 'action_executed', atMs: 2_110, proposalId: PROPOSAL, action: 'send_relance' },
    ]);

    expect(evaluateConfirmationSafety(candidate).issues.map((entry) => entry.code)).toContain(
      'duplicate_action_execution',
    );
  });
});

describe('latences déterministes à seuils explicites', () => {
  const events: readonly RealtimeTraceEvent[] = [
    { type: 'input_started', atMs: 0 },
    { type: 'transcript_final', atMs: 480 },
    { type: 'brain_completed', atMs: 1_020 },
    { type: 'speech_ready', atMs: 1_340 },
    { type: 'audio_started', atMs: 1_420 },
    { type: 'interruption_received', atMs: 2_000 },
    { type: 'audio_stopped', atMs: 2_090 },
  ];

  it('produit toutes les mesures sans les présenter comme un benchmark réseau', () => {
    const testCase = corpusCase('lecture-facture-contextuelle');
    const result = evaluatePipelineLatency(
      trace(testCase, 'webrtc', events),
      STANDARD_LATENCY_BUDGETS,
    );

    expect(result.passed).toBe(true);
    expect(result.measurements).toEqual([
      { metric: 'input_to_transcript_final', observedMs: 480, budgetMs: 600, passed: true },
      { metric: 'transcript_to_brain', observedMs: 540, budgetMs: 700, passed: true },
      { metric: 'brain_to_speech_ready', observedMs: 320, budgetMs: 500, passed: true },
      { metric: 'speech_ready_to_audio_started', observedMs: 80, budgetMs: 150, passed: true },
      { metric: 'input_to_audio_started', observedMs: 1_420, budgetMs: 1_800, passed: true },
      { metric: 'interruption_to_audio_stopped', observedMs: 90, budgetMs: 180, passed: true },
    ]);
  });

  it('échoue explicitement sur dépassement ou jalon absent', () => {
    const testCase = corpusCase('lecture-facture-contextuelle');
    const result = evaluatePipelineLatency(
      trace(testCase, 'mistral-pcm', events.filter((event) => event.type !== 'audio_stopped')),
      { ...STANDARD_LATENCY_BUDGETS, transcript_to_brain: 400 },
    );

    expect(result.passed).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'latency_budget_exceeded',
      'missing_latency_milestone',
    ]));
  });
});

describe('parité sémantique entre transports simulés', () => {
  it('ignore les timings mais exige le même résultat canonique et les mêmes effets', () => {
    const testCase = corpusCase('navigation-nouveau-devis');
    const webRtc = trace(testCase, 'webrtc', [
      { type: 'input_started', atMs: 0 },
      { type: 'audio_acknowledged', atMs: 900, acknowledgementId: ACK },
      { type: 'navigation_committed', atMs: 910, route: '/devis/new' },
    ]);
    const mistral = trace(testCase, 'mistral-pcm', [
      { type: 'input_started', atMs: 0 },
      { type: 'audio_acknowledged', atMs: 1_200, acknowledgementId: ACK },
      { type: 'navigation_committed', atMs: 1_220, route: '/devis/new' },
    ]);

    expect(evaluateTransportParity(webRtc, mistral)).toEqual({ passed: true, issues: [] });
  });

  it('détecte une sélection arbitraire côté transport sur données ambiguës', () => {
    const testCase = corpusCase('client-homonyme-ambigu');
    const webRtc = trace(testCase, 'webrtc', []);
    const mistral = trace(testCase, 'mistral-pcm', [
      { type: 'navigation_committed', atMs: 1_000, route: '/devis/new?client=first' },
    ], {
      state: 'completed',
      kind: 'navigate',
      navigationRoute: '/devis/new?client=first',
    });

    const result = evaluateTransportParity(webRtc, mistral);

    expect(result.passed).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual([
      'semantic_parity_failure',
      'effect_parity_failure',
    ]);
  });
});
