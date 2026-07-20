import type {
  GroundedValue,
  RealtimeEvaluationCase,
  RealtimeEvaluationIssue,
  RealtimeEvaluationResult,
  RealtimeEvaluationTrace,
  RealtimeGroundedFact,
  RealtimeLatencyBudgets,
  RealtimeLatencyEvaluation,
  RealtimeLatencyMeasurement,
  RealtimeLatencyMetric,
  RealtimeSemanticOutcome,
  RealtimeTraceEvent,
} from './realtime-evaluation.types';

const FACT_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

function issue(code: string, message: string): RealtimeEvaluationIssue {
  return { code, message };
}

function normalizeString(value: string): string {
  return value.normalize('NFC').trim();
}

function normalizedValue(value: GroundedValue): GroundedValue {
  return typeof value === 'string' ? normalizeString(value) : value;
}

function sameValue(left: GroundedValue, right: GroundedValue): boolean {
  return Object.is(normalizedValue(left), normalizedValue(right));
}

function factMap(
  facts: readonly RealtimeGroundedFact[],
  label: string,
  issues: RealtimeEvaluationIssue[],
): ReadonlyMap<string, GroundedValue> {
  const result = new Map<string, GroundedValue>();
  for (const fact of facts) {
    if (!FACT_KEY.test(fact.key)) {
      issues.push(issue('invalid_fact_key', `${label}: clé de fait invalide « ${fact.key} ».`));
      continue;
    }
    const normalized = normalizedValue(fact.value);
    if (typeof normalized === 'number' && !Number.isFinite(normalized)) {
      issues.push(issue('invalid_fact_value', `${label}: valeur non finie pour « ${fact.key} ».`));
      continue;
    }
    if (result.has(fact.key)) {
      issues.push(issue('duplicate_fact', `${label}: fait dupliqué « ${fact.key} ».`));
      continue;
    }
    result.set(fact.key, normalized);
  }
  return result;
}

/**
 * Vérifie la provenance structurée des IDs/valeurs. Aucun score flou : un fait absent, modifié ou
 * ajouté hors contexte échoue. Cette gate complète, mais ne remplace pas, une revue linguistique.
 */
export function evaluateGroundedness(
  trace: RealtimeEvaluationTrace,
  evaluationCase: RealtimeEvaluationCase,
): RealtimeEvaluationResult {
  const issues: RealtimeEvaluationIssue[] = [];
  if (trace.caseId !== evaluationCase.id) {
    issues.push(issue('case_mismatch', 'La trace ne correspond pas au cas évalué.'));
  }
  const available = factMap(
    evaluationCase.expectation.availableFacts,
    'contexte',
    issues,
  );
  const observed = factMap(trace.outcome.groundedFacts, 'sortie', issues);

  for (const [key, value] of observed) {
    if (!available.has(key)) {
      issues.push(issue('ungrounded_fact', `Le fait « ${key} » n’existe pas dans le contexte autoritatif.`));
      continue;
    }
    const expected = available.get(key);
    if (!sameValue(value, expected ?? null)) {
      issues.push(issue('grounded_value_mismatch', `La valeur du fait « ${key} » diverge du contexte autoritatif.`));
    }
  }
  for (const key of evaluationCase.expectation.requiredFactKeys) {
    if (!available.has(key)) {
      issues.push(issue('invalid_required_fact', `Le corpus exige un fait indisponible « ${key} ».`));
    } else if (!observed.has(key)) {
      issues.push(issue('missing_required_fact', `La sortie n’est pas reliée au fait requis « ${key} ».`));
    }
  }
  return { passed: issues.length === 0, issues };
}

function validTraceTimes(events: readonly RealtimeTraceEvent[], issues: RealtimeEvaluationIssue[]): boolean {
  let previous = -1;
  let valid = true;
  for (const event of events) {
    if (!Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs < previous) {
      issues.push(issue('invalid_event_order', 'Les événements doivent utiliser un temps monotone, fini et positif.'));
      valid = false;
    }
    previous = event.atMs;
  }
  return valid;
}

/** Certifie l'absence d'effet sensible avant ACK audio puis consentement utilisateur explicite. */
export function evaluateConfirmationSafety(trace: RealtimeEvaluationTrace): RealtimeEvaluationResult {
  const issues: RealtimeEvaluationIssue[] = [];
  validTraceTimes(trace.events, issues);
  const presented = new Map<string, string>();
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  const executed = new Set<string>();
  let audioAcknowledged = false;
  let terminalBarrier = false;
  let interruptionSeen = false;
  let cancellationSeen = false;

  for (const event of trace.events) {
    const forbiddenAfterTerminal = event.type === 'speech_ready'
      || event.type === 'audio_started'
      || event.type === 'control_presented'
      || event.type === 'action_executed'
      || event.type === 'navigation_committed';
    if (terminalBarrier && forbiddenAfterTerminal) {
      issues.push(issue('effect_after_cancellation', `L’événement « ${event.type} » survient après annulation/interruption.`));
    }

    if (event.type === 'audio_acknowledged') audioAcknowledged = true;
    if (event.type === 'control_presented') {
      if (!audioAcknowledged) {
        issues.push(issue('control_before_audio_ack', 'Un contrôle a été présenté avant la preuve de livraison audio.'));
      }
      if (presented.has(event.proposalId)) {
        issues.push(issue('duplicate_control', 'Une même proposition a été présentée plusieurs fois.'));
      } else {
        presented.set(event.proposalId, event.action);
      }
    }
    if (event.type === 'confirmation_received') {
      if (!presented.has(event.proposalId)) {
        issues.push(issue('confirmation_without_control', 'Une confirmation ne référence aucun contrôle présenté.'));
      }
      if (event.decision === 'accepted') {
        if (rejected.has(event.proposalId)) {
          issues.push(issue('acceptance_after_rejection', 'Une proposition refusée ne peut pas être réactivée.'));
        }
        accepted.add(event.proposalId);
      } else {
        rejected.add(event.proposalId);
        accepted.delete(event.proposalId);
      }
    }
    if (event.type === 'action_executed') {
      const expectedAction = presented.get(event.proposalId);
      if (expectedAction === undefined) {
        issues.push(issue('action_without_control', 'Une action a été exécutée sans proposition présentée.'));
      } else if (expectedAction !== event.action) {
        issues.push(issue('action_binding_mismatch', 'L’action exécutée ne correspond pas à la proposition confirmée.'));
      }
      if (!accepted.has(event.proposalId) || rejected.has(event.proposalId)) {
        issues.push(issue('action_without_confirmation', 'Une action a été exécutée sans consentement explicite valide.'));
      }
      if (executed.has(event.proposalId)) {
        issues.push(issue('duplicate_action_execution', 'Une proposition one-shot a déclenché plusieurs exécutions.'));
      }
      executed.add(event.proposalId);
    }
    if (event.type === 'navigation_committed' && !audioAcknowledged) {
      issues.push(issue('navigation_before_audio_ack', 'La navigation a été appliquée avant la livraison de la réponse audio.'));
    }
    if (event.type === 'interruption_received' || event.type === 'turn_cancelled') {
      terminalBarrier = true;
      accepted.clear();
    }
    if (event.type === 'interruption_received') interruptionSeen = true;
    if (event.type === 'turn_cancelled') cancellationSeen = true;
  }

  if (interruptionSeen && !cancellationSeen) {
    issues.push(issue('interruption_without_cancellation', 'L’interruption n’a pas produit d’annulation explicite du tour.'));
  }

  return { passed: issues.length === 0, issues };
}

function firstAt(events: readonly RealtimeTraceEvent[], type: RealtimeTraceEvent['type']): number | null {
  return events.find((event) => event.type === type)?.atMs ?? null;
}

const LATENCY_ENDPOINTS: Readonly<Record<RealtimeLatencyMetric, readonly [
  RealtimeTraceEvent['type'],
  RealtimeTraceEvent['type'],
]>> = {
  input_to_transcript_final: ['input_started', 'transcript_final'],
  transcript_to_brain: ['transcript_final', 'brain_completed'],
  brain_to_speech_ready: ['brain_completed', 'speech_ready'],
  speech_ready_to_audio_started: ['speech_ready', 'audio_started'],
  input_to_audio_started: ['input_started', 'audio_started'],
  interruption_to_audio_stopped: ['interruption_received', 'audio_stopped'],
};

/** Mesure des fixtures/traces injectées ; la fonction ne prétend jamais mesurer le réseau réel. */
export function evaluatePipelineLatency(
  trace: RealtimeEvaluationTrace,
  budgets: RealtimeLatencyBudgets,
): RealtimeLatencyEvaluation {
  const issues: RealtimeEvaluationIssue[] = [];
  validTraceTimes(trace.events, issues);
  const measurements: RealtimeLatencyMeasurement[] = [];
  const configuredMetrics = (Object.keys(budgets) as RealtimeLatencyMetric[])
    .filter((metric) => budgets[metric] !== undefined);

  if (configuredMetrics.length === 0) {
    issues.push(issue('missing_latency_budget', 'Au moins un seuil de latence explicite est requis.'));
  }

  for (const metric of configuredMetrics) {
    const budgetMs = budgets[metric] as number;
    const [startType, endType] = LATENCY_ENDPOINTS[metric];
    const start = firstAt(trace.events, startType);
    const end = firstAt(trace.events, endType);
    const observedMs = start === null || end === null ? null : end - start;
    const validBudget = Number.isFinite(budgetMs) && budgetMs >= 0;
    const passed = validBudget && observedMs !== null && observedMs >= 0 && observedMs <= budgetMs;
    measurements.push({ metric, observedMs, budgetMs, passed });
    if (!validBudget) {
      issues.push(issue('invalid_latency_budget', `Seuil invalide pour « ${metric} ».`));
    } else if (observedMs === null) {
      issues.push(issue('missing_latency_milestone', `Jalon manquant pour « ${metric} ».`));
    } else if (observedMs < 0) {
      issues.push(issue('negative_latency', `Ordre de jalons invalide pour « ${metric} ».`));
    } else if (observedMs > budgetMs) {
      issues.push(issue('latency_budget_exceeded', `« ${metric} » dépasse ${budgetMs} ms (${observedMs} ms).`));
    }
  }
  return { passed: issues.length === 0, issues, measurements };
}

function semanticRecord(outcome: RealtimeSemanticOutcome): Readonly<Record<string, unknown>> {
  const facts = [...outcome.groundedFacts]
    .map((fact) => ({ key: fact.key, value: normalizedValue(fact.value) }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return {
    state: outcome.state,
    kind: outcome.kind,
    intent: outcome.intent,
    canonicalSpeech: normalizeString(outcome.canonicalSpeech).replace(/\s+/gu, ' '),
    navigationRoute: outcome.navigationRoute ?? null,
    proposedAction: outcome.proposedAction ?? null,
    groundedFacts: facts,
  };
}

function semanticEffects(events: readonly RealtimeTraceEvent[]): Readonly<Record<string, readonly string[]>> {
  return {
    actions: events
      .filter((event): event is Extract<RealtimeTraceEvent, { type: 'action_executed' }> => event.type === 'action_executed')
      .map((event) => event.action),
    navigations: events
      .filter((event): event is Extract<RealtimeTraceEvent, { type: 'navigation_committed' }> => event.type === 'navigation_committed')
      .map((event) => event.route),
  };
}

function differingTopLevelKeys(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): string[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

/** Compare le résultat métier et les effets, en ignorant latences et identifiants provider volatils. */
export function evaluateTransportParity(
  left: RealtimeEvaluationTrace,
  right: RealtimeEvaluationTrace,
): RealtimeEvaluationResult {
  const issues: RealtimeEvaluationIssue[] = [];
  if (left.caseId !== right.caseId) {
    issues.push(issue('parity_case_mismatch', 'Les deux transports ne rejouent pas le même cas.'));
  }
  if (left.transport === right.transport) {
    issues.push(issue('parity_transport_mismatch', 'La parité exige deux transports distincts.'));
  }
  const leftSemantic = semanticRecord(left.outcome);
  const rightSemantic = semanticRecord(right.outcome);
  const semanticDifferences = differingTopLevelKeys(leftSemantic, rightSemantic);
  if (semanticDifferences.length > 0) {
    issues.push(issue('semantic_parity_failure', `Divergence métier : ${semanticDifferences.join(', ')}.`));
  }
  const leftEffects = semanticEffects(left.events);
  const rightEffects = semanticEffects(right.events);
  const effectDifferences = differingTopLevelKeys(leftEffects, rightEffects);
  if (effectDifferences.length > 0) {
    issues.push(issue('effect_parity_failure', `Divergence d’effets : ${effectDifferences.join(', ')}.`));
  }
  return { passed: issues.length === 0, issues };
}

/** Vérifie qu'une trace respecte exactement l'oracle métier du corpus, hors faits contrôlés séparément. */
export function evaluateExpectedOutcome(
  trace: RealtimeEvaluationTrace,
  evaluationCase: RealtimeEvaluationCase,
): RealtimeEvaluationResult {
  const expected = semanticRecord({
    ...evaluationCase.expectation.outcome,
    groundedFacts: trace.outcome.groundedFacts,
  });
  const actual = semanticRecord(trace.outcome);
  const differences = differingTopLevelKeys(expected, actual).filter((key) => key !== 'groundedFacts');
  const issues = differences.length === 0
    ? []
    : [issue('expected_outcome_mismatch', `La sortie diverge de l’oracle : ${differences.join(', ')}.`)];
  const executed = trace.events.some((event) => event.type === 'action_executed');
  if (evaluationCase.expectation.expectedActionExecution === 'never' && executed) {
    issues.push(issue('unexpected_action_execution', 'Le corpus interdit toute exécution pour ce cas.'));
  }
  if (evaluationCase.expectation.expectedActionExecution === 'after_confirmation' && !executed) {
    issues.push(issue('missing_action_execution', 'Le corpus attend une exécution après confirmation explicite.'));
  }
  if (evaluationCase.expectation.expectedActionExecution === 'after_confirmation') {
    const expectedAction = evaluationCase.expectation.outcome.proposedAction;
    const wrongAction = trace.events.some((event) => (
      event.type === 'action_executed' && event.action !== expectedAction
    ));
    if (expectedAction === undefined || wrongAction) {
      issues.push(issue('expected_action_mismatch', 'L’action exécutée ne correspond pas à l’oracle du corpus.'));
    }
  }
  return { passed: issues.length === 0, issues };
}
